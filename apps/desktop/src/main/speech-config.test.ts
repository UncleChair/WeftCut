import { describe, it, expect } from "vitest";
import { createSpeechConfigStore, type SpeechConfigFs } from "./speech-config";

const PATH = "/cfg/speech_config.json";
const DIR = "/cfg";

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs: SpeechConfigFs = {
    exists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFile: (p, t) => {
      files.set(p, t);
    },
    rename: (a, b) => {
      const v = files.get(a);
      if (v === undefined) throw new Error("ENOENT");
      files.set(b, v);
      files.delete(a);
    },
    mkdirp: () => {},
  };
  return { fs, files };
}
const store = (seed?: Record<string, string>) =>
  createSpeechConfigStore({ ...memFs(seed), path: PATH, dir: DIR });

describe("speech-config store", () => {
  it("defaults to auto with no local engines when no file", () => {
    expect(store().get()).toEqual({ preferred_engine: "auto", local: {} });
  });

  // The project-specific hazard: an OLD config lacking preferred_engine must
  // load as "auto", NEVER undefined (an undefined selector value blanks the UI).
  it("backfills preferred_engine to auto when the field is missing", () => {
    const s = store({ [PATH]: '{ "local": {} }' });
    expect(s.get().preferred_engine).toBe("auto");
  });

  it("backfills auto for a wrong-typed / unrecognized preferred_engine", () => {
    expect(store({ [PATH]: '{ "preferred_engine": true }' }).get().preferred_engine).toBe("auto");
    expect(store({ [PATH]: '{ "preferred_engine": "bogus" }' }).get().preferred_engine).toBe("auto");
  });

  it("corrupt file falls back to defaults (no throw)", () => {
    expect(store({ [PATH]: "{ not valid json" }).get()).toEqual({
      preferred_engine: "auto",
      local: {},
    });
  });

  it("preferred_engine round-trips through an independent reader", () => {
    const { fs, files } = memFs();
    const s = createSpeechConfigStore({ fs, path: PATH, dir: DIR });
    expect(s.apply({ preferred_engine: "whisper_cpp" }).preferred_engine).toBe("whisper_cpp");
    expect(createSpeechConfigStore({ fs, path: PATH, dir: DIR }).get().preferred_engine).toBe(
      "whisper_cpp",
    );
    expect(files.has(PATH + ".tmp")).toBe(false); // tmp promoted, not left behind
  });

  it("sets, reads back, and clears a local engine config", () => {
    const { fs } = memFs();
    const s = createSpeechConfigStore({ fs, path: PATH, dir: DIR });
    const after = s.apply({
      local: {
        backend: "whisper_cpp",
        config: { binary: " /opt/w/whisper-cli ", model: "/opt/w/ggml.bin", device: "cpu", threads: 8 },
      },
    });
    expect(after.local.whisper_cpp).toEqual({
      binary: "/opt/w/whisper-cli", // trimmed
      model: "/opt/w/ggml.bin",
      device: "cpu",
      threads: 8,
    });
    // Independent reader sees the persisted value.
    expect(createSpeechConfigStore({ fs, path: PATH, dir: DIR }).get().local.whisper_cpp.model).toBe(
      "/opt/w/ggml.bin",
    );
    // Clearing removes the entry.
    const cleared = s.apply({ local: { backend: "whisper_cpp", config: null } });
    expect(cleared.local.whisper_cpp).toBeUndefined();
  });

  // FunASR's model bundle adds a tokens.txt path; it must round-trip.
  it("sets and reads back a FunASR local config with a tokens path", () => {
    const { fs } = memFs();
    const s = createSpeechConfigStore({ fs, path: PATH, dir: DIR });
    const after = s.apply({
      local: {
        backend: "funasr",
        config: {
          binary: "/opt/sherpa/sherpa-onnx-offline",
          model: "/opt/sherpa/paraformer.onnx",
          tokens: " /opt/sherpa/tokens.txt ",
        },
      },
    });
    expect(after.local.funasr).toEqual({
      binary: "/opt/sherpa/sherpa-onnx-offline",
      model: "/opt/sherpa/paraformer.onnx",
      tokens: "/opt/sherpa/tokens.txt", // trimmed
    });
    // Independent reader sees the persisted tokens path.
    expect(
      createSpeechConfigStore({ fs, path: PATH, dir: DIR }).get().local.funasr.tokens,
    ).toBe("/opt/sherpa/tokens.txt");
  });

  // ADDITIVE-FIELD SAFETY: an OLD speech_config.json whose local entry predates
  // `tokens` must load fine (tokens simply undefined) — never blank/throw.
  it("loads a pre-tokens local entry with tokens undefined", () => {
    const s = store({
      [PATH]:
        '{ "preferred_engine": "auto", "local": { "funasr": { "binary": "/b", "model": "/m" } } }',
    });
    const entry = s.get().local.funasr;
    expect(entry).toEqual({ binary: "/b", model: "/m" });
    expect(entry.tokens).toBeUndefined();
  });

  it("omits a blank tokens path", () => {
    const { fs } = memFs();
    const s = createSpeechConfigStore({ fs, path: PATH, dir: DIR });
    const after = s.apply({
      local: { backend: "funasr", config: { binary: "/b", model: "/m", tokens: "   " } },
    });
    expect(after.local.funasr).toEqual({ binary: "/b", model: "/m" });
  });

  it("drops a local entry with neither binary nor model", () => {
    const s = store({
      [PATH]: '{ "preferred_engine": "auto", "local": { "whisper_cpp": { "binary": "", "model": "" } } }',
    });
    expect(s.get().local.whisper_cpp).toBeUndefined();
  });

  it("omits blank device and non-positive threads", () => {
    const { fs } = memFs();
    const s = createSpeechConfigStore({ fs, path: PATH, dir: DIR });
    const after = s.apply({
      local: { backend: "whisper_cpp", config: { binary: "/b", model: "/m", device: "  ", threads: 0 } },
    });
    expect(after.local.whisper_cpp).toEqual({ binary: "/b", model: "/m" });
  });
});
