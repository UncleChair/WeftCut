import { describe, expect, it } from "vitest";
import { CONTENT_CATALOG } from "./content-catalog";
import { contentPlatformKey } from "./content-download";

// The catalog is a supply-chain surface: every entry must stay pinned
// (immutable versioned URL + exact bytes + SHA-256) so a drive-by "bump the
// URL" edit cannot silently turn a verified artifact into a rolling one.
// These invariants gate every current AND future entry.

const allArtifacts = CONTENT_CATALOG.flatMap((item) =>
  Object.entries(item.platforms).map(([platform, artifact]) => ({
    id: item.id,
    platform,
    artifact,
  })),
);

describe("content catalog pinning invariants", () => {
  it("ids are unique and every item covers at least one platform", () => {
    const ids = CONTENT_CATALOG.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of CONTENT_CATALOG) {
      expect(Object.keys(item.platforms).length).toBeGreaterThan(0);
    }
  });

  it("every artifact pins an https URL that is not a rolling endpoint", () => {
    for (const { id, artifact } of allArtifacts) {
      expect(artifact.url, id).toMatch(/^https:\/\//);
      // "latest" anywhere in the URL is the canonical mutable-endpoint smell
      // (GitHub /releases/latest/, HF /resolve/main/ is caught by the next
      // assertion requiring the pinned revision to appear in the URL).
      expect(artifact.url, id).not.toContain("latest");
    }
  });

  it("model URLs embed the exact pinned revision, never a branch name", () => {
    for (const item of CONTENT_CATALOG) {
      for (const artifact of Object.values(item.platforms)) {
        if (artifact.url.includes("huggingface.co")) {
          expect(artifact.url, item.id).toContain(item.version);
          expect(artifact.url, item.id).not.toContain("/resolve/main/");
        }
      }
    }
  });

  it("every artifact pins a 64-hex sha256 and a positive byte count", () => {
    for (const { id, artifact } of allArtifacts) {
      expect(artifact.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes, id).toBeGreaterThan(0);
      expect(Number.isInteger(artifact.bytes), id).toBe(true);
    }
  });

  it("entry paths are relative and traversal-free (they name a file inside the install dir)", () => {
    for (const { id, artifact } of allArtifacts) {
      expect(artifact.entryPath, id).not.toMatch(/^([a-zA-Z]:)?[\\/]/);
      expect(artifact.entryPath, id).not.toContain("..");
      expect(artifact.entryPath.length, id).toBeGreaterThan(0);
    }
  });

  it("speech consumer field paths obey the same relative/traversal-free rule", () => {
    for (const item of CONTENT_CATALOG) {
      for (const rel of Object.values(item.speech?.fields ?? {})) {
        expect(rel, item.id).not.toMatch(/^([a-zA-Z]:)?[\\/]/);
        expect(rel, item.id).not.toContain("..");
        expect(rel.length, item.id).toBeGreaterThan(0);
      }
    }
  });

  it("platform keys are the ContentPlatformKey scheme", () => {
    for (const { id, platform } of allArtifacts) {
      const [os, arch] = platform.split("-");
      expect(contentPlatformKey(os!, arch!), `${id}: ${platform}`).toBe(
        platform,
      );
    }
  });
});

describe("the ADR 0039 slice is present verbatim", () => {
  it("whisper.cpp v1.9.1 Windows runtime", () => {
    const runtime = CONTENT_CATALOG.find((i) => i.id === "whisper-cpp-runtime");
    const win = runtime?.platforms["win32-x64"];
    expect(win?.bytes).toBe(7982101);
    expect(win?.sha256).toBe(
      "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
    );
    expect(win?.entryPath).toBe("Release/whisper-cli.exe");
    expect(runtime?.speech).toEqual({
      backend: "whisper_cpp",
      fields: { binary: "Release/whisper-cli.exe" },
    });
  });

  it("multilingual Base model at the pinned HF revision", () => {
    const model = CONTENT_CATALOG.find((i) => i.id === "whisper-model-base");
    const win = model?.platforms["win32-x64"];
    expect(win?.bytes).toBe(147951465);
    expect(win?.sha256).toBe(
      "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    );
    // The multilingual Base, not base.en and not a quantized variant.
    expect(win?.entryPath).toBe("ggml-base.bin");
    expect(model?.version).toBe("5359861c739e955e79d9a303bcbc70fb988958b1");
    expect(model?.speech).toEqual({
      backend: "whisper_cpp",
      fields: { model: "ggml-base.bin" },
    });
  });
});

describe("the ADR 0043 slice is present verbatim", () => {
  it("sherpa-onnx v1.13.4 shared-MD-Release Windows runtime", () => {
    const runtime = CONTENT_CATALOG.find((i) => i.id === "funasr-runtime");
    const win = runtime?.platforms["win32-x64"];
    expect(win?.bytes).toBe(20034576);
    expect(win?.sha256).toBe(
      "d4dacc8be5afe03f22ade4d50cfd587c03a625eaca8c41f2d99a24d3db463eab",
    );
    expect(win?.archive).toBe("tar.bz2");
    // The versioned tag URL, not the rolling one.
    expect(win?.url).toContain("/releases/download/v1.13.4/");
    expect(runtime?.speech).toEqual({
      backend: "funasr",
      fields: {
        binary:
          "sherpa-onnx-v1.13.4-win-x64-shared-MD-Release/bin/sherpa-onnx-offline.exe",
      },
    });
  });

  it("Paraformer-zh 2023-09-14: one archive fills model AND tokens", () => {
    const model = CONTENT_CATALOG.find(
      (i) => i.id === "funasr-model-paraformer-zh",
    );
    const win = model?.platforms["win32-x64"];
    expect(win?.bytes).toBe(234051698);
    expect(win?.sha256).toBe(
      "9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03",
    );
    expect(win?.archive).toBe("tar.bz2");
    expect(model?.speech).toEqual({
      backend: "funasr",
      fields: {
        model: "sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx",
        tokens: "sherpa-onnx-paraformer-zh-2023-09-14/tokens.txt",
      },
    });
  });
});
