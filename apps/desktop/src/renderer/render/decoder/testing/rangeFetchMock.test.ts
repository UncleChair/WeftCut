import { describe, it, expect } from "vitest";
import { makeRangeFetchMock } from "./rangeFetchMock";

const buf = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

describe("makeRangeFetchMock", () => {
  it("serves an inclusive byte range as 206 with Content-Range", async () => {
    const m = makeRangeFetchMock(buf);
    const res = await m.fetch("weftcut-media://x", { headers: { Range: "bytes=2-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([2, 3, 4]),
    );
    expect(m.bytesServed()).toBe(3);
  });

  it("serves the whole file as 200 when no Range", async () => {
    const m = makeRangeFetchMock(buf);
    const res = await m.fetch("weftcut-media://x");
    expect(res.status).toBe(200);
    expect(m.bytesServed()).toBe(10);
  });
});
