import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ContentDownloadProgress,
  ContentItem,
} from "../shared/content-download";
import type { ContentDeps, ContentFs, ZipEntry } from "./contentDownload";
import {
  downloadItem,
  itemStatus,
  speechAutofillPlan,
  sweepPartials,
} from "./contentDownload";

// The whole lifecycle runs against an in-memory fs and a scripted http stream
// — no network, no real disk. What these tests pin is the CONTRACT the
// packaged app relies on: a failed transfer retries, a hostile archive never
// escapes staging, and an install is only "installed" once manifest.json
// exists (written last).

// ---------------------------------------------------------------------------
// In-memory fs: paths are joined with "/" and stored flat; directories are
// implicit (mkdirp tracked only so rm can be checked against real behavior).

function memFs(): ContentFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const under = (prefix: string) => (p: string) =>
    p === prefix || p.startsWith(prefix + "/");
  return {
    files,
    mkdirp: () => {},
    rm: (path) => {
      for (const key of [...files.keys()]) {
        if (under(path)(key)) files.delete(key);
      }
    },
    rename: (from, to) => {
      const moved: Array<[string, Uint8Array]> = [];
      for (const [key, data] of files) {
        if (under(from)(key)) moved.push([to + key.slice(from.length), data]);
      }
      if (moved.length === 0) throw new Error(`rename: missing ${from}`);
      for (const key of [...files.keys()]) {
        if (under(from)(key)) files.delete(key);
      }
      for (const [key, data] of moved) files.set(key, data);
    },
    statBytes: (path) => {
      const data = files.get(path);
      return data ? data.byteLength : null;
    },
    writeText: (path, text) => {
      files.set(path, new TextEncoder().encode(text));
    },
    writeBytes: (path, data) => {
      files.set(path, data);
    },
    openWrite: (path) => {
      const chunks: Uint8Array[] = [];
      files.set(path, new Uint8Array());
      return {
        write: (chunk) => {
          chunks.push(chunk);
          files.set(path, concat(chunks));
        },
        close: () => {},
      };
    },
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function* streamOf(
  data: Uint8Array,
  chunkSize = 4,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.byteLength; i += chunkSize) {
    yield data.slice(i, i + chunkSize);
  }
}

// One deps bundle per test: payload-configurable http, optional zip entries,
// optional scripted tar.bz2 extraction (entries the fake extractor "unpacks").
function makeDeps(opts: {
  fs?: ContentFs;
  responses: Array<Uint8Array | Error>;
  zipEntries?: readonly ZipEntry[];
  tarEntries?: readonly ZipEntry[] | Error;
}): ContentDeps & { fetches: number; extractCalls: string[][] } {
  const fs = opts.fs ?? memFs();
  const bundle = {
    fetches: 0,
    extractCalls: [] as string[][],
    fs,
    http: {
      get: async (_url: string, _signal: AbortSignal) => {
        const next = opts.responses[bundle.fetches];
        bundle.fetches += 1;
        if (next === undefined) throw new Error("no scripted response left");
        if (next instanceof Error) throw next;
        return streamOf(next);
      },
    },
    readZipEntries: async () => opts.zipEntries ?? [],
    extractTarBz2: async (archivePath: string, destDir: string) => {
      bundle.extractCalls.push([archivePath, destDir]);
      if (opts.tarEntries instanceof Error) throw opts.tarEntries;
      for (const entry of opts.tarEntries ?? []) {
        fs.writeBytes(`${destDir}/${entry.path}`, entry.data);
      }
    },
    join: (...parts: string[]) => parts.join("/"),
    downloadsDir: "root/downloads",
    partialDir: "root/cache/content-partial",
    now: () => "2026-08-13T00:00:00.000Z",
  };
  return bundle;
}

const PAYLOAD = new TextEncoder().encode("model-bytes-0123456789");

function rawItem(payload = PAYLOAD): ContentItem {
  return {
    id: "test-model",
    kind: "speech-model",
    version: "rev1",
    labelKey: "x",
    license: { name: "MIT", upstreamUrl: "https://example.com" },
    platforms: {
      "win32-x64": {
        url: "https://example.com/model.bin",
        sha256: sha256(payload),
        bytes: payload.byteLength,
        archive: "none",
        entryPath: "model.bin",
      },
    },
  };
}

function zipItem(archiveBytes: Uint8Array): ContentItem {
  return {
    id: "test-runtime",
    kind: "speech-runtime",
    version: "1.0.0",
    labelKey: "x",
    license: { name: "MIT", upstreamUrl: "https://example.com" },
    platforms: {
      "win32-x64": {
        url: "https://example.com/runtime.zip",
        sha256: sha256(archiveBytes),
        bytes: archiveBytes.byteLength,
        archive: "zip",
        entryPath: "Release/tool.exe",
      },
    },
  };
}

const noProgress = (): void => {};
const live = () => new AbortController().signal;

describe("downloadItem — raw payload happy path", () => {
  it("installs to <id>/<version>/, writes manifest.json last, reports done", async () => {
    const deps = makeDeps({ responses: [PAYLOAD] });
    const ticks: ContentDownloadProgress[] = [];
    const result = await downloadItem(
      deps,
      rawItem(),
      "win32-x64",
      (p) => ticks.push(p),
      live(),
    );

    expect(result).toEqual({
      ok: true,
      entryPath: "root/downloads/test-model/rev1/model.bin",
    });
    expect(deps.extractCalls).toEqual([]);
    expect(
      deps.fs.statBytes("root/downloads/test-model/rev1/model.bin"),
    ).toBe(PAYLOAD.byteLength);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        (deps.fs as ReturnType<typeof memFs>).files.get(
          "root/downloads/test-model/rev1/manifest.json",
        ),
      ),
    ) as { sha256: string; installedAt: string };
    expect(manifest.sha256).toBe(sha256(PAYLOAD));
    expect(manifest.installedAt).toBe("2026-08-13T00:00:00.000Z");
    // Phases arrive in lifecycle order and finish with done.
    const phases = ticks.map((t) => t.phase);
    expect(phases[0]).toBe("download");
    expect(phases).toContain("verify");
    expect(phases.at(-1)).toBe("done");
    // No partial left behind.
    expect(
      deps.fs.statBytes("root/cache/content-partial/test-model.part"),
    ).toBeNull();
  });
});

describe("downloadItem — transfer-stage failures retry, then fail loud", () => {
  it("sha mismatch: retries to the attempt cap, then reports the digest error", async () => {
    const wrong = new TextEncoder().encode("not-the-model-bytes---");
    expect(wrong.byteLength).toBe(PAYLOAD.byteLength);
    const deps = makeDeps({ responses: [wrong, wrong, wrong] });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());

    expect(deps.fetches).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : "error" in result ? result.error : "").toContain(
      "sha256 mismatch",
    );
  });

  it("byte-count mismatch fails verification even when the digest would match a truncation", async () => {
    const truncated = PAYLOAD.slice(0, 10);
    const deps = makeDeps({ responses: [truncated, truncated, truncated] });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : "error" in result ? result.error : "").toContain(
      "size mismatch",
    );
  });

  it("a network throw on attempt 1 succeeds on attempt 2 (the fetch-ffmpeg retry discipline)", async () => {
    const deps = makeDeps({
      responses: [new Error("ECONNRESET mid-stream"), PAYLOAD],
    });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(deps.fetches).toBe(2);
  });
});

describe("downloadItem — cancellation is quiet", () => {
  it("aborting mid-stream returns cancelled (not error) and leaves no partial", async () => {
    const controller = new AbortController();
    const deps = makeDeps({ responses: [PAYLOAD] });
    let aborted = false;
    const result = await downloadItem(
      deps,
      rawItem(),
      "win32-x64",
      (p) => {
        // Abort after the first chunk tick.
        if (p.phase === "download" && !aborted) {
          aborted = true;
          controller.abort();
        }
      },
      controller.signal,
    );
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(
      deps.fs.statBytes("root/cache/content-partial/test-model.part"),
    ).toBeNull();
    expect(
      deps.fs.statBytes("root/downloads/test-model/rev1/manifest.json"),
    ).toBeNull();
  });
});

describe("downloadItem — zip extraction", () => {
  const archive = new TextEncoder().encode("zip-archive-stand-in");

  it("extracts entries into the version dir and resolves the entry path", async () => {
    const deps = makeDeps({
      responses: [archive],
      zipEntries: [
        { path: "Release/", data: new Uint8Array() },
        { path: "Release/tool.exe", data: new TextEncoder().encode("exe") },
        { path: "Release/dep.dll", data: new TextEncoder().encode("dll") },
      ],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result).toEqual({
      ok: true,
      entryPath: "root/downloads/test-runtime/1.0.0/Release/tool.exe",
    });
    expect(
      deps.fs.statBytes("root/downloads/test-runtime/1.0.0/Release/dep.dll"),
    ).toBe(3);
  });

  it("a traversal entry aborts the install without retrying (the payload already hashed clean)", async () => {
    const deps = makeDeps({
      responses: [archive, archive, archive],
      zipEntries: [
        { path: "../outside.exe", data: new TextEncoder().encode("bad") },
      ],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(deps.fetches).toBe(1);
    // Nothing escaped, nothing installed.
    const files = (deps.fs as ReturnType<typeof memFs>).files;
    expect([...files.keys()].filter((k) => k.includes("outside"))).toEqual([]);
    expect(
      deps.fs.statBytes("root/downloads/test-runtime/1.0.0/manifest.json"),
    ).toBeNull();
  });

  it("an absolute entry path is rejected the same way", async () => {
    const deps = makeDeps({
      responses: [archive],
      zipEntries: [{ path: "C:/evil.exe", data: new Uint8Array([1]) }],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(deps.fetches).toBe(1);
  });

  it("backslash-authored entries extract normalized instead of failing", async () => {
    const deps = makeDeps({
      responses: [archive],
      zipEntries: [
        { path: "Release\\tool.exe", data: new TextEncoder().encode("exe") },
      ],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(
      deps.fs.statBytes("root/downloads/test-runtime/1.0.0/Release/tool.exe"),
    ).toBe(3);
  });
});

describe("downloadItem — tar.bz2 extraction (delegated to the injected extractor)", () => {
  const archive = new TextEncoder().encode("tar-bz2-archive-stand-in");

  function tarItem(): ContentItem {
    return {
      id: "test-tarball",
      kind: "speech-runtime",
      version: "2.0.0",
      labelKey: "x",
      license: { name: "Apache-2.0", upstreamUrl: "https://example.com" },
      platforms: {
        "win32-x64": {
          url: "https://example.com/bundle.tar.bz2",
          sha256: sha256(archive),
          bytes: archive.byteLength,
          archive: "tar.bz2",
          entryPath: "bundle/bin/tool.exe",
        },
      },
    };
  }

  it("extracts via the adapter into staging and installs atomically", async () => {
    const deps = makeDeps({
      responses: [archive],
      tarEntries: [
        { path: "bundle/bin/tool.exe", data: new TextEncoder().encode("exe") },
        { path: "bundle/tokens.txt", data: new TextEncoder().encode("a b") },
      ],
    });
    const result = await downloadItem(deps, tarItem(), "win32-x64", noProgress, live());
    expect(result).toEqual({
      ok: true,
      entryPath: "root/downloads/test-tarball/2.0.0/bundle/bin/tool.exe",
    });
    // The extractor ran on the verified partial, targeting the staging dir.
    expect(deps.extractCalls).toEqual([
      [
        "root/cache/content-partial/test-tarball.part",
        "root/downloads/test-tarball/.staging-2.0.0",
      ],
    ]);
    expect(
      deps.fs.statBytes("root/downloads/test-tarball/2.0.0/bundle/tokens.txt"),
    ).toBe(3);
    expect(
      deps.fs.statBytes("root/cache/content-partial/test-tarball.part"),
    ).toBeNull();
  });

  it("an extractor refusal (hostile archive) fails without retrying", async () => {
    const deps = makeDeps({
      responses: [archive, archive, archive],
      tarEntries: new Error("archive entry escapes the destination: ../x"),
    });
    const result = await downloadItem(deps, tarItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(deps.fetches).toBe(1);
    expect(
      deps.fs.statBytes("root/downloads/test-tarball/2.0.0/manifest.json"),
    ).toBeNull();
  });
});

describe("itemStatus", () => {
  it("walks the whole ladder: unavailable → not_installed → installed → corrupt", async () => {
    const deps = makeDeps({ responses: [PAYLOAD] });
    const item = rawItem();

    expect(itemStatus(deps, item, null)).toEqual({ state: "unavailable" });
    expect(itemStatus(deps, item, "win32-x64")).toEqual({
      state: "not_installed",
    });

    await downloadItem(deps, item, "win32-x64", noProgress, live());
    expect(itemStatus(deps, item, "win32-x64")).toEqual({
      state: "installed",
      entryPath: "root/downloads/test-model/rev1/model.bin",
      installDir: "root/downloads/test-model/rev1",
    });

    // Payload vanishes but the manifest claim remains → corrupt, not
    // not_installed: the UI must offer a re-download that explains itself.
    deps.fs.rm("root/downloads/test-model/rev1/model.bin");
    expect(itemStatus(deps, item, "win32-x64")).toEqual({ state: "corrupt" });
  });

  it("a raw payload with the wrong size on disk is corrupt (the pinned size IS the payload size)", async () => {
    const deps = makeDeps({ responses: [PAYLOAD] });
    const item = rawItem();
    await downloadItem(deps, item, "win32-x64", noProgress, live());
    deps.fs.writeBytes(
      "root/downloads/test-model/rev1/model.bin",
      new Uint8Array([1, 2, 3]),
    );
    expect(itemStatus(deps, item, "win32-x64")).toEqual({ state: "corrupt" });
  });
});

describe("sweepPartials", () => {
  it("clears crash leftovers and leaves the dir ready for the next stream", () => {
    const deps = makeDeps({ responses: [] });
    deps.fs.writeBytes(
      "root/cache/content-partial/test-model.part",
      new Uint8Array([1]),
    );
    sweepPartials(deps);
    expect(
      deps.fs.statBytes("root/cache/content-partial/test-model.part"),
    ).toBeNull();
  });
});

describe("speechAutofillPlan — the only-if-blank / whole-set consumer rules", () => {
  const join = (...parts: string[]) => parts.join("/");
  const runtime: ContentItem = {
    ...rawItem(),
    id: "engine",
    kind: "speech-runtime",
    speech: { backend: "whisper_cpp", fields: { binary: "bin/cli.exe" } },
  };
  const model: ContentItem = {
    ...rawItem(),
    id: "model",
    kind: "speech-model",
    speech: { backend: "whisper_cpp", fields: { model: "m.bin" } },
  };
  const installed = (dir: string) =>
    ({ state: "installed", entryPath: `${dir}/x`, installDir: dir }) as const;

  it("both installed + blank config → one entry with fields resolved against install dirs", () => {
    const plan = speechAutofillPlan(
      [runtime, model],
      (i) => installed(i.id === "engine" ? "/dl/engine/v1" : "/dl/model/v1"),
      {},
      join,
    );
    expect(plan).toEqual([
      {
        backend: "whisper_cpp",
        config: { binary: "/dl/engine/v1/bin/cli.exe", model: "/dl/model/v1/m.bin" },
      },
    ]);
  });

  it("one archive can fill several fields (the Paraformer model+tokens shape)", () => {
    const funasrRuntime: ContentItem = {
      ...rawItem(),
      id: "fa-engine",
      speech: { backend: "funasr", fields: { binary: "sherpa/bin/sherpa-onnx-offline.exe" } },
    };
    const funasrModel: ContentItem = {
      ...rawItem(),
      id: "fa-model",
      speech: {
        backend: "funasr",
        fields: { model: "para/model.int8.onnx", tokens: "para/tokens.txt" },
      },
    };
    const plan = speechAutofillPlan(
      [funasrRuntime, funasrModel],
      (i) => installed(i.id === "fa-engine" ? "/dl/fa-e/1" : "/dl/fa-m/1"),
      {},
      join,
    );
    expect(plan).toEqual([
      {
        backend: "funasr",
        config: {
          binary: "/dl/fa-e/1/sherpa/bin/sherpa-onnx-offline.exe",
          model: "/dl/fa-m/1/para/model.int8.onnx",
          tokens: "/dl/fa-m/1/para/tokens.txt",
        },
      },
    ]);
  });

  it("a half set configures nothing (engine installed, model missing)", () => {
    const plan = speechAutofillPlan(
      [runtime, model],
      (i) =>
        i.id === "engine" ? installed("/dl/engine/v1") : { state: "not_installed" },
      {},
      join,
    );
    expect(plan).toEqual([]);
  });

  it("any manual path wins outright — even a partially-filled manual entry", () => {
    const statusOf = (i: ContentItem) =>
      installed(i.id === "engine" ? "/dl/engine/v1" : "/dl/model/v1");
    expect(
      speechAutofillPlan(
        [runtime, model],
        statusOf,
        { whisper_cpp: { binary: "C:/my/whisper.exe", model: "" } },
        join,
      ),
    ).toEqual([]);
    expect(
      speechAutofillPlan(
        [runtime, model],
        statusOf,
        { whisper_cpp: { binary: "", model: "C:/my/model.bin" } },
        join,
      ),
    ).toEqual([]);
  });

  it("an all-blank existing entry counts as blank and is filled", () => {
    const plan = speechAutofillPlan(
      [runtime, model],
      (i) => installed(i.id === "engine" ? "/e" : "/m"),
      { whisper_cpp: { binary: "", model: "  " } },
      join,
    );
    expect(plan).toHaveLength(1);
  });

  it("platform-unavailable items don't block the set (they're not part of it here)", () => {
    const other: ContentItem = {
      ...rawItem(),
      id: "other-os-tokens",
      speech: { backend: "whisper_cpp", fields: { tokens: "t.txt" } },
    };
    const plan = speechAutofillPlan(
      [runtime, model, other],
      (i) =>
        i.id === "other-os-tokens"
          ? { state: "unavailable" }
          : installed(i.id === "engine" ? "/e" : "/m"),
      {},
      join,
    );
    expect(plan).toEqual([
      { backend: "whisper_cpp", config: { binary: "/e/bin/cli.exe", model: "/m/m.bin" } },
    ]);
  });
});
