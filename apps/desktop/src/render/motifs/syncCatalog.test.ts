import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../ipc", () => ({
  listMotifs: vi.fn(),
}));

import { listMotifs as ipcListMotifs } from "../../ipc";
import { syncUserMotifsFromBackend } from "./syncCatalog";
import { getMotif, setUserMotifs } from "./catalog";

describe("syncUserMotifsFromBackend", () => {
  beforeEach(() => setUserMotifs([]));

  it("registers backend user motifs into the runtime catalog", async () => {
    (ipcListMotifs as ReturnType<typeof vi.fn>).mockResolvedValue([
      // The IPC payload carries manifest fields + an extra `html` field.
      { id: "from-backend", name: "BE", version: 1, size: [320, 240], default_duration_s: 2, props_schema: {}, html: "<html></html>" },
      { id: "countdown", name: "Countdown", version: 1, size: [480, 480], default_duration_s: 5, props_schema: {}, html: "x" },
    ]);
    await syncUserMotifsFromBackend();
    expect(getMotif("from-backend")?.manifest.size).toEqual([320, 240]);
    // Built-in still authoritative (size unchanged by the backend echo).
    expect(getMotif("countdown")?.manifest.size).toEqual([480, 480]);
  });

  it("swallows IPC errors (catalog stays built-in-only)", async () => {
    (ipcListMotifs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ipc down"));
    await expect(syncUserMotifsFromBackend()).resolves.toBeUndefined();
    expect(getMotif("from-backend")).toBeNull();
  });
});
