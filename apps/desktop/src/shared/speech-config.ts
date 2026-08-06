// Speech-backend config types, shared by the Electron main process (owner of
// persistence, src/main/speech-config.ts) and the renderer (consumer via ipc).
// One definition → no main↔renderer drift.
//
// Non-secret config only — the OpenAI API key lives in safeStorage
// (main/keys.ts). See ADR 0036 "Config splits by secrecy".

/// The engine the user prefers for transcription. `"auto"` lets the resolver
/// pick by availability (its default order). The concrete tags mirror the Rust
/// `SpeechBackend::as_str` wire contract.
export type PreferredEngine = "auto" | "openai" | "whisper_cpp" | "funasr";

export const PREFERRED_ENGINES: readonly PreferredEngine[] = [
  "auto",
  "openai",
  "whisper_cpp",
  "funasr",
];

/// One local engine's on-disk config. `device` / `threads` are optional hints
/// (empty = engine default). `tokens` is the FunASR (sherpa-onnx Paraformer)
/// `tokens.txt` beside the model — part of its model bundle; whisper.cpp leaves
/// it undefined. Paths are stored verbatim (trimmed) as the OS returned them
/// from the native picker — the Rust availability probe does the file-existence
/// check.
export interface LocalEngineConfig {
  binary: string;
  model: string;
  tokens?: string;
  device?: string;
  threads?: number;
}

/// The persisted speech config (<userData>/speech_config.json).
export interface SpeechConfig {
  preferred_engine: PreferredEngine;
  /// Per-local-engine config, keyed by the backend tag (`"whisper_cpp"` /
  /// `"funasr"`). Cloud backends (`"openai"`) configure their key via keys.ts,
  /// never here, so they never appear in this map.
  local: Record<string, LocalEngineConfig>;
}

/// Patch shape — every field optional; the store merges into current config,
/// persists atomically, and returns the post-patch snapshot. A `local` patch
/// sets one engine's config, or clears it when `config` is `null`.
export interface SpeechConfigPatch {
  preferred_engine?: PreferredEngine;
  local?: { backend: string; config: LocalEngineConfig | null };
}

export const SPEECH_CONFIG_DEFAULTS: SpeechConfig = {
  // ADDITIVE-FIELD SAFETY: an old speech_config.json (or none) that lacks
  // preferred_engine must load as "auto", never undefined — an undefined
  // engine would blank the Settings selector. The store's read() backfills
  // this default in its single parse function.
  preferred_engine: "auto",
  local: {},
};
