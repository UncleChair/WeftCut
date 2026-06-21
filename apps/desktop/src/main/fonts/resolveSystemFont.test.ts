// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFamilyName } from "./resolveSystemFont.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("readFamilyName", () => {
  it("reads the family from a TTF/OTF name table", () => {
    const otf = fs.readFileSync(
      path.resolve(__dirname, "../../../assets/fonts/NotoSansSC-VF.ttf"),
    );
    const name = readFamilyName(otf);
    expect(name?.toLowerCase()).toContain("noto");
  });
});
