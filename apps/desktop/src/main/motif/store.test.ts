import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UserMotifStore } from "./store";
import { composeMotifHtml, type Manifest } from "../../shared/motifs/catalog";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "motif-store-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function man(id: string, name: string, version: number): Manifest {
  return { id, name, version, size: [100, 100], default_duration_s: 1, props_schema: {} };
}
const body = "<head></head><body><script>motif.define({setup(){}})</script></body>";

describe("UserMotifStore drafts + publish", () => {
  it("write_draft → list + get", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", composeMotifHtml(man("d1", "Draft One", 1), body));
    expect(s.listDraftIds()).toEqual(["d1"]);
    expect(s.listManifests()).toEqual([]);
    expect(s.getDraft("d1")?.manifest.id).toBe("d1");
  });
  it("install_new publishes and removes draft", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo", 1), body));
    s.installDraft("foo", "foo");
    expect(s.listManifests().map((m) => m.id)).toEqual(["foo"]);
    expect(s.listDraftIds()).toEqual([]);
  });
  it("install over an existing published id (update path)", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo v1", 1), body));
    s.installDraft("foo", "foo");
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo v2", 2), body));
    s.installDraft("foo", "foo");
    const parsed = s.listManifests().find((m) => m.id === "foo")!;
    expect(parsed.version).toBe(2);
    expect(parsed.name).toBe("Foo v2");
    expect(s.publishedIds()).toEqual(["foo"]);
  });
  it("delete removes published + draft", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", composeMotifHtml(man("d1", "D1", 1), body));
    expect(s.listDraftIds()).toEqual(["d1"]);
    s.deleteUserMotif("d1");
    expect(s.listDraftIds()).toEqual([]);
  });
});

describe("UserMotifStore path safety", () => {
  it("rejects traversal in readFile", () => {
    const s = new UserMotifStore(root);
    expect(s.readFile("user-x", "../secret.txt")).toBeNull();
    expect(s.readFile("user-x", "a/../../b")).toBeNull();
    expect(s.readFile("..", "index.html")).toBeNull();
    expect(s.readFile("user-x", "/etc/hosts")).toBeNull();
    expect(s.readFile("user-x", "a\\b")).toBeNull();
    expect(s.readFile("user-x", ".")).toBeNull();
    expect(s.readFile("user-x", "")).toBeNull();
    expect(s.readFile("user-x", "C:/foo")).toBeNull();
    expect(s.readFile("drafts", "index.html")).toBeNull();
  });
  it("rejects unsafe ids on the write surface", () => {
    const s = new UserMotifStore(root);
    expect(() => s.writeDraft("..", "html")).toThrow();
    expect(() => s.writeDraft("a/b", "html")).toThrow();
    expect(() => s.writeDraft("", "html")).toThrow();
    expect(() => s.deleteUserMotif("..")).toThrow();
    expect(() => s.installDraft("ok", "../escape")).toThrow();
  });
});

describe("UserMotifStore reads", () => {
  it("reads an existing asset + html", () => {
    const dir = path.join(root, "user-x");
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    const manifestJson = `{"id":"user-x","name":"X","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}`;
    writeFileSync(path.join(dir, "index.html"), `<script type="application/json" id="motif-manifest">${manifestJson}</script><script>motif.define({setup(){}})</script>`);
    writeFileSync(path.join(dir, "assets", "logo.svg"), "<svg/>");
    const s = new UserMotifStore(root);
    expect(s.readFile("user-x", "assets/logo.svg")?.toString()).toBe("<svg/>");
    expect(s.readHtml("user-x")).toContain("motif.define");
    expect(s.getMotif("user-x")?.manifest.id).toBe("user-x");
  });
  it("lists installed, skipping drafts and broken", () => {
    const dir = path.join(root, "user-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), `<script type="application/json" id="motif-manifest">{"id":"user-a","name":"A","version":1,"size":[10,10],"default_duration_s":1,"props_schema":{}}</script>`);
    mkdirSync(path.join(root, "drafts", "wip"), { recursive: true });
    writeFileSync(path.join(root, "drafts", "wip", "index.html"), "draft");
    mkdirSync(path.join(root, "broken"), { recursive: true });
    writeFileSync(path.join(root, "broken", "index.html"), "<html>no island</html>");
    const s = new UserMotifStore(root);
    expect(s.listManifests().map((m) => m.id)).toEqual(["user-a"]);
  });
  it("missing root is empty", () => {
    const s = new UserMotifStore(path.join(root, "no", "such", "dir"));
    expect(s.listManifests()).toEqual([]);
    expect(s.readHtml("anything")).toBeNull();
  });
  it("hasFile resolves published-then-draft and refuses unsafe paths", () => {
    const s = new UserMotifStore(root);
    // Draft-only: the companion sits beside the draft's index.html.
    s.writeDraft("foo", composeMotifHtml(man("foo", "Foo", 1), body));
    expect(s.hasFile("foo", "params.html")).toBe(false);
    writeFileSync(path.join(root, "drafts", "foo", "params.html"), "<html>p</html>");
    expect(s.hasFile("foo", "params.html")).toBe(true);
    // Published copy answers once installed (the draft dir moved with it).
    s.installDraft("foo", "foo");
    expect(s.hasFile("foo", "params.html")).toBe(true);
    // A published motif WITHOUT the file must not inherit a same-id draft's.
    s.writeDraft("bar", composeMotifHtml(man("bar", "Bar", 1), body));
    s.installDraft("bar", "bar");
    expect(s.hasFile("bar", "params.html")).toBe(false);
    // Same traversal guards as readFile.
    expect(s.hasFile("foo", "../params.html")).toBe(false);
    expect(s.hasFile("..", "params.html")).toBe(false);
    expect(s.hasFile("drafts", "params.html")).toBe(false);
    expect(s.hasFile("foo", "")).toBe(false);
  });
  it("readFile falls back to draft then prefers published", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("foo", composeMotifHtml(man("foo", "Draft Foo", 1), "<head></head><body>draft<script>motif.define({setup(){}})</script></body>"));
    expect(s.readFile("foo", "index.html")?.toString()).toContain("draft");
    s.installDraft("foo", "foo");
    expect(s.listDraftIds()).toEqual([]);
    expect(s.readFile("foo", "index.html")?.toString()).toContain("draft");
  });
  it("draft target sidecar round-trips and defaults absent", () => {
    const s = new UserMotifStore(root);
    s.writeDraft("d1", "<html>x</html>");
    expect(s.readDraftTarget("d1")).toBeNull();
    s.writeDraftTarget("d1", "lower-third");
    expect(s.readDraftTarget("d1")).toBe("lower-third");
    s.deleteUserMotif("d1");
    expect(s.readDraftTarget("d1")).toBeNull();
  });
});
