// Video-understanding (VLM) backend config types, shared by the Electron main
// process (owner of persistence, src/main/vlm-config.ts) and the renderer
// (consumer via ipc). One definition → no main↔renderer drift. Twin of
// shared/speech-config.ts.
//
// Same secrecy split as ADR 0036: a cloud VLM API KEY is secret and stays in
// safeStorage (main/keys.ts, cloud_keys.json) — NEVER stored here. This store
// holds only NON-secret config: the preferred engine, each LOCAL engine's
// binary/model/mmproj paths (+ device hint), and a BYO endpoint's URL/model (its
// optional key is secret and would live in safeStorage). Electron main merges
// the non-secret config + the cloud key into the Rust `vlm_config` snapshot the
// stateless describe_clip resolver reads (see toVlmBackendSnapshot).

/// The engine the user prefers for description. `"auto"` lets the resolver pick
/// by availability (its local-first default order). The concrete tags mirror the
/// Rust `VlmBackend::as_str` wire contract.
export type VlmPreferredEngine =
  | "auto"
  | "qwen3_vl"
  | "minicpm_v"
  | "byo_endpoint"
  | "cloud";

export const VLM_PREFERRED_ENGINES: readonly VlmPreferredEngine[] = [
  "auto",
  "qwen3_vl",
  "minicpm_v",
  "byo_endpoint",
  "cloud",
];

/// One local engine's on-disk config: the `llama-mtmd-cli` binary, the model
/// GGUF, and its vision projector (`mmproj`) — all three are needed for vision.
/// `device` is an optional GPU hint (empty = engine default). Paths are stored
/// verbatim (trimmed) as the OS picker returned them; the Rust availability probe
/// does the file-existence check.
export interface VlmLocalEngineConfig {
  binary: string;
  model: string;
  mmproj: string;
  device?: string;
}

/// A BYO OpenAI-compatible endpoint (self-hosted llama-server / vLLM / SGLang).
/// `url` is the full `/v1/chat/completions` URL; `model` names the served model.
/// `api_key` is optional and secret — persisted only if a self-hosted server
/// needs one (kept out of logs by the redactor).
export interface VlmEndpointConfig {
  url: string;
  model?: string;
  api_key?: string;
}

/// The persisted VLM config (<userData>/vlm_config.json).
export interface VlmConfig {
  preferred_engine: VlmPreferredEngine;
  /// Per-local-engine config, keyed by the backend tag (`"qwen3_vl"` /
  /// `"minicpm_v"`). Cloud/endpoint backends never appear here.
  local: Record<string, VlmLocalEngineConfig>;
  /// The single BYO endpoint config, when configured.
  endpoint?: VlmEndpointConfig;
}

/// Patch shape — every field optional; the store merges, persists atomically,
/// and returns the post-patch snapshot. A `local` patch sets one engine's config
/// or clears it when `config` is `null`; an `endpoint` patch sets or clears it.
export interface VlmConfigPatch {
  preferred_engine?: VlmPreferredEngine;
  local?: { backend: string; config: VlmLocalEngineConfig | null };
  endpoint?: VlmEndpointConfig | null;
}

export const VLM_CONFIG_DEFAULTS: VlmConfig = {
  // ADDITIVE-FIELD SAFETY: an old vlm_config.json (or none) that lacks
  // preferred_engine must load as "auto", never undefined — an undefined engine
  // would blank a Settings selector. The store's read() backfills this default.
  preferred_engine: "auto",
  local: {},
};
