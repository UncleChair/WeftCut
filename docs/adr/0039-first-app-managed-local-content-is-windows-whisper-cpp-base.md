---
status: accepted
---

# The first app-managed local-content slice is Windows x64 whisper.cpp v1.9.1 with multilingual Base

[ADR 0036](0036-pluggable-speech-backends-normalized-transcript.md) established
whisper.cpp as the first local speech backend, but deliberately left model and
runtime provisioning as user-supplied paths. We now want users to obtain local
engines and models through the app, while proving the content flow on one
verified vertical slice before extending it to more platforms, speech engines,
vision models, or shot detectors.

## Decision

The first phase targets **Windows x64, CPU-only whisper.cpp**, using these
immutable upstream artifacts:

- Runtime: whisper.cpp **v1.9.1**
  [`whisper-bin-x64.zip`](https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip),
  7,982,101 bytes,
  SHA-256 `7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539`.
  The runtime is the archive's complete `Release/` directory, including the
  dynamically selected CPU backend DLLs; its entry point is
  `Release/whisper-cli.exe`.
- Model: multilingual **Base**
  [`ggml-base.bin`](https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin?download=true)
  at Hugging Face revision
  `5359861c739e955e79d9a303bcbc70fb988958b1`, 147,951,465 bytes,
  SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`.
  This is neither the English-only `ggml-base.en.bin` nor a quantized Base
  variant.

This exact pair has passed a local Windows CPU smoke test against the current
sidecar contract: v1.9.1 accepted `-m`, `-f`, `-ojf`, `-osrt`, `-of`, `-l`, and
`-t`; the Base model reported `multilingual: true`; and both JSON-full and SRT
transcription completed on the JFK sample.

The catalog must pin versioned URLs, byte counts, revisions, and SHA-256 values;
it must not resolve a mutable `latest` URL. whisper.cpp and the original Whisper
code and weights are MIT-licensed, so their notices travel with the managed
content record. The official Windows runtime dynamically imports the Microsoft
Visual C++ v14 x64 runtime (`MSVCP140`, `VCRUNTIME140[_1]`, and `VCOMP140`), so
that runtime is an explicit platform prerequisite rather than an unrecorded
assumption.

This ADR selects the first content and its dependency boundary only. The
detailed design for the catalog manifest, download and recovery lifecycle,
on-disk layout, configuration reference, UI, and prerequisite handling is
deferred to the implementation-design session.

## Consequences

- Phase-one completion means this fixed runtime/model pair can be obtained and
  used from inside the Windows app without manually locating either file.
- Existing manual-path configuration remains a supported fallback and
  compatibility path.
- CUDA/BLAS packages, other Whisper model sizes, automatic upgrades, Linux,
  macOS, FunASR, VLM content, and TransNetV2 are outside this phase.
- Later content types may use this slice as the reference workflow, but this ADR
  does not pre-commit their packaging or runtime architecture.
