---
status: accepted
---

# The second app-managed content slice is Windows x64 sherpa-onnx v1.13.4 with Paraformer-zh

[ADR 0039](0039-first-app-managed-local-content-is-windows-whisper-cpp-base.md)
proved the app-managed content flow on whisper.cpp. FunASR (Chinese speech
recognition, served by the sherpa-onnx runtime — [ADR 0036](0036-pluggable-speech-backends-normalized-transcript.md))
is the highest-value next slice: the backend is fully implemented and
verified, and only manual provisioning stands between a user and Chinese
transcription.

## Decision

The second slice targets **Windows x64, CPU-only sherpa-onnx** with the
Paraformer-zh model, using these upstream artifacts:

- Runtime: sherpa-onnx **v1.13.4**
  [`sherpa-onnx-v1.13.4-win-x64-shared-MD-Release.tar.bz2`](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-shared-MD-Release.tar.bz2),
  20,034,576 bytes, SHA-256
  `d4dacc8be5afe03f22ade4d50cfd587c03a625eaca8c41f2d99a24d3db463eab`
  (double-confirmed: the GitHub release-asset digest and the local archive
  validated against the sidecar contract on 2026-07-24 agree). Entry point
  `sherpa-onnx-v1.13.4-win-x64-shared-MD-Release/bin/sherpa-onnx-offline.exe`.
  The MD build dynamically links the Microsoft Visual C++ v14 x64 runtime —
  the same recorded prerequisite as the whisper.cpp runtime.
- Model: **Paraformer-zh (2023-09-14 export)**
  [`sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2`](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2),
  234,051,698 bytes, SHA-256
  `9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03`.
  The archive carries BOTH files the backend needs:
  `sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx` (243,371,218 bytes)
  and `sherpa-onnx-paraformer-zh-2023-09-14/tokens.txt` — one catalog item
  fills two config fields, which is why `SpeechConsumer` maps
  field → relative-path instead of naming a single field.
  This asset hangs off the **rolling `asr-models` release tag**, not a
  version tag. The byte-count source is the GitHub API; the SHA-256 source
  is the local archive downloaded from that URL on 2026-07-24 (the asset
  predates GitHub's release-asset digests). The pinned SHA-256 is what
  carries the trust: if upstream ever swaps the asset behind the URL, the
  download fails loudly instead of installing.

This exact pair passed the full in-app pipeline on 2026-07-24 (config IPC →
resolver → ffmpeg audio extract → sherpa subprocess → word-timed normalized
`Transcript`). Newer Paraformer exports exist upstream (2024-03-09,
int8-2025-10-07); per the ADR 0039 convention the validated pair is pinned,
and an upgrade is a NEW catalog entry decided through an ADR update.

**Licensing.** The runtime is Apache-2.0 (k2-fsa/sherpa-onnx). The model has
two license signals, both recorded here deliberately: the official FunASR
organization publishes paraformer-zh on Hugging Face with license
`apache-2.0`, while the FunASR repository also carries a bespoke
`MODEL_LICENSE` (redistribution and commercial use permitted, attribution
required, plus an unusual anti-disparagement clause with auto-termination).
The managed-content `manifest.json` records name + upstream URL, which
satisfies the attribution requirement; and the download manager fetches from
upstream on the user's request, so WeftCut points at the model rather than
redistributing it.

**tar.bz2 extraction happens in Rust.** sherpa-onnx publishes no zip assets
for Windows (verified across v1.13.4 and v1.13.5) and neither does the model
release, so tar.bz2 support is unavoidable. It lands as a stateless
`content_extract_archive` backend command (`tar` was already in the
dependency graph; `bzip2` is the one new crate) rather than a JS
implementation: native bzip2 decodes a 234 MB archive in seconds where a JS
decoder would take an order of magnitude longer, and it keeps Rust in its
stateless-compute role ([ADR 0024](0024-stateless-compute-service.md)). The
path-traversal guard for tar entries is the `tar` crate's `unpack`
containment (entries that would escape the destination are refused), mirrored
by a Rust test; zip entries keep the TypeScript-side guard.

## Consequences

- Slice completion means Chinese transcription works from a fresh Windows
  install without the user locating any file by hand; manual paths remain a
  supported fallback.
- The catalog schema gains multi-field speech consumers and a `tar.bz2`
  archive kind; the extraction adapter seam now has two implementations
  (fflate in main, tar+bzip2 in Rust).
- CUDA builds, other Paraformer exports, streaming (online) models, TTS
  voices, and non-Windows platforms stay out of this slice.
