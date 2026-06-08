import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { installMotif, deleteMotif, writeMotifDraft, getMotifSource } from "./index";

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
});
