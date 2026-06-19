import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { installMotif, deleteMotif, writeMotifDraft, getMotifSource, amendMotifDraft, createEditDraft, importMotif } from "./index";

describe("motif lifecycle IPC wrappers", () => {
  it("installMotif sends the snake_case nested args Tauri's serde expects", async () => {
    invoke.mockResolvedValue("foo");
    await installMotif("d1", { kind: "update", target_id: "foo" });
    expect(invoke).toHaveBeenCalledWith("install_motif", {
      args: { draft_id: "d1", mode: { kind: "update", target_id: "foo" } },
    });
  });
  it("writeMotifDraft wraps {manifest, html} under args", async () => {
    invoke.mockResolvedValue("d1");
    const manifest = { id: "x", name: "X", version: 1, size: [1, 1], default_duration_s: 1, props_schema: {} };
    await writeMotifDraft(manifest as never, "<html></html>");
    expect(invoke).toHaveBeenCalledWith("write_motif_draft", { args: { manifest, html: "<html></html>" } });
  });
  it("deleteMotif passes a bare id", async () => {
    invoke.mockResolvedValue(undefined);
    await deleteMotif("foo");
    expect(invoke).toHaveBeenCalledWith("delete_motif", { id: "foo" });
  });
  it("installMotif new-mode sends the right shape", async () => {
    invoke.mockResolvedValue("d2");
    await installMotif("d2", { kind: "new" });
    expect(invoke).toHaveBeenCalledWith("install_motif", {
      args: { draft_id: "d2", mode: { kind: "new" } },
    });
  });
  it("getMotifSource passes a bare id", async () => {
    invoke.mockResolvedValue({ manifest: { id: "x" }, html: "" });
    await getMotifSource("x");
    expect(invoke).toHaveBeenCalledWith("get_motif_source", { id: "x" });
  });
  it("amendMotifDraft passes draft_id + source (camelCased top-level args)", async () => {
    invoke.mockResolvedValue(undefined);
    await amendMotifDraft("d1", "<html>edited</html>");
    expect(invoke).toHaveBeenCalledWith("amend_motif_draft", {
      draftId: "d1",
      source: "<html>edited</html>",
    });
  });
  it("createEditDraft passes sourceId (camelCased top-level arg)", async () => {
    invoke.mockResolvedValue("foo-2");
    const id = await createEditDraft("foo");
    expect(invoke).toHaveBeenCalledWith("create_edit_draft", { sourceId: "foo" });
    expect(id).toBe("foo-2");
  });
  it("importMotif passes the path (camelCased top-level arg)", async () => {
    invoke.mockResolvedValue("imported-2");
    const id = await importMotif("C:/x/foo.html");
    expect(invoke).toHaveBeenCalledWith("import_motif", { path: "C:/x/foo.html" });
    expect(id).toBe("imported-2");
  });
});
