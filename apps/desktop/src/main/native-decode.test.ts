import { describe, expect, it } from "vitest";
import { loadNativeDecodeWith } from "./native-decode";

describe("loadNativeDecodeWith", () => {
  it("returns the backend and version when require succeeds", () => {
    const fakeInstance = { marker: true };
    const mod = {
      NativeDecode: class {
        constructor(public onEvent: unknown) {}
        static instance = fakeInstance;
      },
      versionInfo: () => "avcodec=61 avutil=59",
    };
    const r = loadNativeDecodeWith(() => mod as never, () => {}, null);
    expect(r.backend).not.toBeNull();
    expect(r.version).toBe("avcodec=61 avutil=59");
    expect(r.reason).toBeNull();
  });

  it("degrades to unavailable when require throws (missing DLL)", () => {
    const r = loadNativeDecodeWith(
      () => { throw new Error("The specified module could not be found."); },
      () => {},
      null,
    );
    expect(r.backend).toBeNull();
    expect(r.reason).toContain("could not be found");
    expect(r.version).toBeNull();
  });

  it("prepends the DLL dir to PATH before requiring (Windows contract)", () => {
    const seen: string[] = [];
    const prevPath = process.env.PATH;
    loadNativeDecodeWith(
      () => { seen.push(process.env.PATH ?? ""); throw new Error("stop"); },
      () => {},
      "C:\\bundled\\native-decode",
    );
    expect(seen[0]!.startsWith("C:\\bundled\\native-decode")).toBe(true);
    expect(process.env.PATH).toBe(prevPath); // restored on failure
  });
});
