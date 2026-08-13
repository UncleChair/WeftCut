// The app-managed content catalog: every artifact the app can download for
// the user, pinned to immutable versioned URLs with byte counts and SHA-256
// digests (supply-chain rule, docs/licensing.md — never a rolling "latest").
//
// Values are verbatim from ADR 0039 (Windows x64 CPU-only whisper.cpp v1.9.1
// + multilingual Base) and ADR 0043 (sherpa-onnx v1.13.4 + Paraformer-zh for
// the FunASR backend). Do not re-derive or "refresh" them — a new upstream
// release is a NEW catalog entry with its own pinned url/bytes/sha, decided
// through an ADR update, not an edit here.
//
// content-catalog.test.ts enforces the pinning invariants over every entry.

import type { ContentItem } from "./content-download";

export const CONTENT_CATALOG: readonly ContentItem[] = [
  {
    id: "whisper-cpp-runtime",
    kind: "speech-runtime",
    version: "1.9.1",
    labelKey: "content_whisper_runtime",
    license: { name: "MIT", upstreamUrl: "https://github.com/ggml-org/whisper.cpp" },
    // The official Windows build dynamically imports the Microsoft Visual C++
    // v14 x64 runtime (MSVCP140, VCRUNTIME140[_1], VCOMP140) — ADR 0039 makes
    // that an explicit prerequisite rather than an unrecorded assumption.
    prerequisiteKey: "content_prereq_msvc14",
    speech: { backend: "whisper_cpp", fields: { binary: "Release/whisper-cli.exe" } },
    platforms: {
      "win32-x64": {
        url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
        sha256:
          "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
        bytes: 7982101,
        archive: "zip",
        // The runtime is the archive's complete Release/ directory (the
        // dynamically selected CPU backend DLLs must stay beside the exe).
        entryPath: "Release/whisper-cli.exe",
      },
    },
  },
  {
    id: "whisper-model-base",
    kind: "speech-model",
    // Hugging Face revision — the model file is platform-independent, but it
    // still installs under <id>/<version>/ like everything else.
    version: "5359861c739e955e79d9a303bcbc70fb988958b1",
    labelKey: "content_whisper_model_base",
    license: {
      name: "MIT",
      upstreamUrl: "https://huggingface.co/ggerganov/whisper.cpp",
    },
    speech: { backend: "whisper_cpp", fields: { model: "ggml-base.bin" } },
    platforms: {
      // Multilingual Base — neither ggml-base.en.bin nor a quantized variant
      // (ADR 0039). Byte-identical on every platform; listed per-platform so
      // coverage stays an explicit decision as other OSes phase in.
      "win32-x64": {
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin?download=true",
        sha256:
          "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        bytes: 147951465,
        archive: "none",
        entryPath: "ggml-base.bin",
      },
    },
  },
  {
    id: "funasr-runtime",
    kind: "speech-runtime",
    version: "1.13.4",
    labelKey: "content_funasr_runtime",
    license: { name: "Apache-2.0", upstreamUrl: "https://github.com/k2-fsa/sherpa-onnx" },
    // The shared-MD build dynamically links the MSVC v14 x64 runtime, same as
    // the whisper.cpp runtime above (ADR 0043).
    prerequisiteKey: "content_prereq_msvc14",
    speech: {
      backend: "funasr",
      fields: {
        binary:
          "sherpa-onnx-v1.13.4-win-x64-shared-MD-Release/bin/sherpa-onnx-offline.exe",
      },
    },
    platforms: {
      "win32-x64": {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-shared-MD-Release.tar.bz2",
        // Double-confirmed: GitHub's release-asset digest and the locally
        // validated archive agree (ADR 0043).
        sha256:
          "d4dacc8be5afe03f22ade4d50cfd587c03a625eaca8c41f2d99a24d3db463eab",
        bytes: 20034576,
        archive: "tar.bz2",
        entryPath:
          "sherpa-onnx-v1.13.4-win-x64-shared-MD-Release/bin/sherpa-onnx-offline.exe",
      },
    },
  },
  {
    id: "funasr-model-paraformer-zh",
    kind: "speech-model",
    version: "2023-09-14",
    labelKey: "content_funasr_model_paraformer",
    // Apache-2.0 per the official FunASR org's Hugging Face model card; the
    // FunASR repo's bespoke MODEL_LICENSE is the second recorded signal — both
    // in ADR 0043. The manifest's name + upstream record satisfies its
    // attribution requirement.
    license: {
      name: "Apache-2.0",
      upstreamUrl: "https://huggingface.co/funasr/paraformer-zh",
    },
    // One archive fills two config fields — model AND tokens ride together.
    speech: {
      backend: "funasr",
      fields: {
        model: "sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx",
        tokens: "sherpa-onnx-paraformer-zh-2023-09-14/tokens.txt",
      },
    },
    platforms: {
      // Platform-independent data, listed per-platform like the whisper model
      // so coverage stays an explicit decision as other OSes phase in.
      "win32-x64": {
        // ⚠️ Rolling `asr-models` release tag, not a version tag — the pinned
        // sha256 below is what carries the trust (ADR 0043): a swapped asset
        // fails verification loudly instead of installing.
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2",
        sha256:
          "9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03",
        bytes: 234051698,
        archive: "tar.bz2",
        entryPath: "sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx",
      },
    },
  },
];
