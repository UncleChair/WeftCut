// Speech-backend config persisted at <userData>/speech_config.json, owned by
// the Electron main process. NON-secret: the preferred engine + each local
// engine's binary/model paths (device/threads hints). The OpenAI API KEY is
// secret and lives in safeStorage (keys.ts / cloud_keys.json) — NEVER here.
// (ADR 0036 "Config splits by secrecy".)
//
// The on-disk file path + JSON field names are a COMPATIBILITY SURFACE: once
// users have a speech_config.json it must keep loading, so neither may change
// without a migration. Bad-config recovery: a missing / empty / corrupt file,
// or one written by an older build that lacks a field, degrades to defaults —
// preferred_engine backfills to "auto" so the Settings selector never blanks.

import {
  SPEECH_CONFIG_DEFAULTS,
  PREFERRED_ENGINES,
  type SpeechConfig,
  type SpeechConfigPatch,
  type PreferredEngine,
  type LocalEngineConfig,
} from "../shared/speech-config";

/** Minimal fs surface — injected so tests run in-memory; node:fs in production.
 *  Mirrors AppSettingsFs (atomic tmp-then-rename write). */
export interface SpeechConfigFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdirp(dir: string): void;
}

export interface SpeechConfigStore {
  get(): SpeechConfig;
  /** Apply a patch atomically; returns the post-patch config. */
  apply(patch: SpeechConfigPatch): SpeechConfig;
}

function isPreferred(v: unknown): v is PreferredEngine {
  return typeof v === "string" && (PREFERRED_ENGINES as readonly string[]).includes(v);
}

/// Coerce one on-disk local-engine entry into a valid `LocalEngineConfig`, or
/// `null` when it has no usable binary/model. Trims paths (verbatim otherwise —
/// no lowercasing, so display stays faithful and the OS-returned casing is
/// preserved); carries `tokens` when present (FunASR's model-bundle file — an
/// old config that predates it simply omits it, no migration needed); drops
/// empty/blank device/tokens and non-finite threads.
function readLocalEntry(raw: unknown): LocalEngineConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const binary = typeof o.binary === "string" ? o.binary.trim() : "";
  const model = typeof o.model === "string" ? o.model.trim() : "";
  if (binary === "" && model === "") return null;
  const out: LocalEngineConfig = { binary, model };
  if (typeof o.tokens === "string" && o.tokens.trim() !== "") out.tokens = o.tokens.trim();
  if (typeof o.device === "string" && o.device.trim() !== "") out.device = o.device.trim();
  if (typeof o.threads === "number" && Number.isFinite(o.threads) && o.threads > 0) {
    out.threads = Math.floor(o.threads);
  }
  return out;
}

export function createSpeechConfigStore(deps: {
  fs: SpeechConfigFs;
  path: string;
  dir: string;
}): SpeechConfigStore {
  function read(): SpeechConfig {
    if (!deps.fs.exists(deps.path)) return { preferred_engine: "auto", local: {} };
    let body: string;
    try {
      body = deps.fs.readFile(deps.path);
    } catch (e) {
      console.warn(`[speech-config] read ${deps.path}:`, e);
      return { preferred_engine: "auto", local: {} };
    }
    if (body.trim() === "") return { preferred_engine: "auto", local: {} };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[speech-config] parse ${deps.path}:`, e);
      return { preferred_engine: "auto", local: {} };
    }
    // Per-field defaulting (the ONE backfill point): a missing / wrong-typed
    // preferred_engine falls back to "auto" so the selector is never undefined.
    const preferred_engine: PreferredEngine = isPreferred(parsed.preferred_engine)
      ? parsed.preferred_engine
      : SPEECH_CONFIG_DEFAULTS.preferred_engine;
    const local: Record<string, LocalEngineConfig> = {};
    if (parsed.local && typeof parsed.local === "object") {
      for (const [tag, raw] of Object.entries(parsed.local as Record<string, unknown>)) {
        const entry = readLocalEntry(raw);
        if (entry) local[tag] = entry;
      }
    }
    return { preferred_engine, local };
  }

  function write(cfg: SpeechConfig): void {
    deps.fs.mkdirp(deps.dir);
    const tmp = deps.path + ".tmp";
    deps.fs.writeFile(tmp, JSON.stringify(cfg, null, 2));
    deps.fs.rename(tmp, deps.path); // atomic promote
  }

  return {
    get: read,
    apply(patch) {
      const current = read();
      if (patch.preferred_engine !== undefined && isPreferred(patch.preferred_engine)) {
        current.preferred_engine = patch.preferred_engine;
      }
      if (patch.local !== undefined) {
        if (patch.local.config === null) {
          delete current.local[patch.local.backend];
        } else {
          const entry = readLocalEntry(patch.local.config);
          if (entry) current.local[patch.local.backend] = entry;
          else delete current.local[patch.local.backend];
        }
      }
      write(current);
      return current;
    },
  };
}
