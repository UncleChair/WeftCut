import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { captureMotifFramePngBlob } from "../host";

describe("captureMotifFramePngBlob", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes motif_capture_frame and returns a PNG Blob of the decoded base64", async () => {
    invokeMock.mockResolvedValue("AQID"); // base64 of [1,2,3]
    const blob = await captureMotifFramePngBlob("countdown", 2.5, { seconds: 5 }, 480, 480, 1);
    expect(invokeMock).toHaveBeenCalledWith("motif_capture_frame", {
      motifId: "countdown",
      tSec: 2.5,
      propsJson: JSON.stringify({ seconds: 5 }),
      width: 480,
      height: 480,
      settleRafs: 1,
    });
    expect(blob.type).toBe("image/png");
    expect(await blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)))).toEqual([1, 2, 3]);
  });
});
