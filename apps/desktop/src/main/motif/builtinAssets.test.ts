import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveMotifFile, contentTypeFor } from "./builtinAssets";
import { UserMotifStore } from "./store";

// The real relocated built-in dir, resolved from THIS test file's location
// (src/main/motif → ../../shared/motifs/builtin = src/shared/motifs/builtin).
const BUILTIN_DIR = path.resolve(__dirname, "../../shared/motifs/builtin");

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "motif-assets-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("contentTypeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("assets/x.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("weird")).toBe("application/octet-stream");
  });
});

describe("resolveMotifFile", () => {
  it("serves a built-in index.html (built-in wins)", () => {
    const s = new UserMotifStore(root);
    const file = resolveMotifFile(BUILTIN_DIR, s, "countdown", "index.html");
    expect(file).not.toBeNull();
    expect(file!.contentType).toBe("text/html; charset=utf-8");
    expect(file!.bytes.toString("utf8")).toContain("motif.define");
  });
  it("serves a built-in font asset", () => {
    const s = new UserMotifStore(root);
    const file = resolveMotifFile(BUILTIN_DIR, s, "lower-third", "assets/Inter.woff2");
    expect(file).not.toBeNull();
    expect(file!.contentType).toBe("font/woff2");
    expect(file!.bytes.length).toBeGreaterThan(0);
  });
  it("falls back to the user store for a non-built-in id", () => {
    const dir = path.join(root, "user-z");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), "<html>user-z</html>");
    const s = new UserMotifStore(root);
    expect(resolveMotifFile(BUILTIN_DIR, s, "user-z", "index.html")!.bytes.toString("utf8")).toBe("<html>user-z</html>");
  });
  it("returns null for an unknown id", () => {
    const s = new UserMotifStore(root);
    expect(resolveMotifFile(BUILTIN_DIR, s, "nope", "index.html")).toBeNull();
  });
  it("rejects a traversal in a built-in rest path", () => {
    const s = new UserMotifStore(root);
    expect(resolveMotifFile(BUILTIN_DIR, s, "countdown", "../../../etc/hosts")).toBeNull();
  });
});
