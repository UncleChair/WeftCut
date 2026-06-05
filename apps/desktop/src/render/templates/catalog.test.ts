import { describe, test, expect } from "vitest";
import { getTemplate } from "./catalog";
describe("catalog index.html format", () => {
  test("countdown: engine svg, html holds <svg> + render()", () => {
    const t = getTemplate("countdown");
    expect(t).not.toBeNull();
    expect(t!.manifest.engine).toBe("svg");
    expect(t!.html).toContain("<svg");
    expect(t!.html).toContain("function render");
    expect((t as unknown as { css?: string }).css).toBeUndefined();
  });
});
