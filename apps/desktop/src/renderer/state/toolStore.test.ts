import { beforeEach, describe, expect, it } from "vitest";

import { activeTool, setTool, useToolStore } from "./toolStore";

describe("toolStore", () => {
  beforeEach(() => {
    useToolStore.setState({ tool: "select" });
  });

  it("defaults to the selection tool", () => {
    expect(activeTool()).toBe("select");
  });

  it("arms a tool", () => {
    setTool("blade");
    expect(activeTool()).toBe("blade");
  });

  // One key per tool: pressing a tool's key twice must leave you on that tool,
  // not bounce you back to Selection (see the LANDMINE on `setTool`).
  it("is idempotent — re-arming the active tool is a no-op", () => {
    setTool("blade");
    setTool("blade");
    expect(activeTool()).toBe("blade");
  });

  it("does not notify subscribers when the tool is unchanged", () => {
    let notifications = 0;
    const unsubscribe = useToolStore.subscribe(() => {
      notifications += 1;
    });
    setTool("select");
    expect(notifications).toBe(0);
    setTool("blade");
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("returns to the selection tool", () => {
    setTool("blade");
    setTool("select");
    expect(activeTool()).toBe("select");
  });
});
