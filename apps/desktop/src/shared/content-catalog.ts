// The app-managed content catalog: every artifact the app can download for
// the user, pinned to immutable versioned URLs with byte counts and SHA-256
// digests (supply-chain rule, docs/licensing.md — never a rolling "latest").
//
// Values are verbatim from ADR 0039 (the accepted phase-one slice: Windows
// x64 CPU-only whisper.cpp v1.9.1 + multilingual Base). Do not re-derive or
// "refresh" them — a new upstream release is a NEW catalog entry with its own
// pinned url/bytes/sha, decided through an ADR update, not an edit here.
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
    speech: { backend: "whisper_cpp", field: "binary" },
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
    speech: { backend: "whisper_cpp", field: "model" },
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
];
