// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", () => ({ logEmit: vi.fn(() => Promise.resolve()) }));

import { logEmit } from "../ipc";
import type { LogEntryInput } from "../ipc";
import { createExportLogMirror } from "./exportLog";

const rows = (): LogEntryInput[] =>
  vi.mocked(logEmit).mock.calls.map((c) => c[0]);

const CTX = { output: "C:/out/final.mp4", codec: "h264" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(logEmit).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createExportLogMirror", () => {
  it("slow run: Started at 250 ms, then Ok under the same op_id", () => {
    const m = createExportLogMirror();
    m.begin(CTX);
    m.observe({ kind: "starting" });
    expect(logEmit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    m.observe({
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 2_000_000 },
    });

    const [started, ok] = rows();
    expect(started).toMatchObject({
      level: "info",
      category: { kind: "Export" },
      source: { kind: "User" },
      message: `Exporting ${CTX.output}`,
      op_state: { state: "Started" },
    });
    expect(ok).toMatchObject({
      level: "info",
      message: `Exported ${CTX.output}`,
      op_state: { state: "Ok" },
      details: { duration_us: 2_000_000 },
    });
    expect(ok!.op_id).toBe(started!.op_id);
    expect(rows()).toHaveLength(2);
  });

  it("fast failure: one Error row, no op_id, no late Started", () => {
    const m = createExportLogMirror();
    m.begin(CTX);
    m.observe({ kind: "starting" });
    m.observe({ kind: "error", detail: "boom" });
    vi.advanceTimersByTime(1000);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      level: "error",
      message: "Export failed: boom",
      details: { output: CTX.output, error: "boom" },
    });
    expect(rows()[0]!.op_id).toBeUndefined();
  });

  it("refused before it began (idle → error) logs one standalone Error row", () => {
    const m = createExportLogMirror();
    m.begin(CTX);
    m.observe({ kind: "error", detail: "no video material" });
    vi.advanceTimersByTime(1000);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      level: "error",
      message: "Export failed: no video material",
    });
    expect(rows()[0]!.op_id).toBeUndefined();
  });

  it("cancel (running → null) closes a Started op as Ok", () => {
    const m = createExportLogMirror();
    m.begin(CTX);
    m.observe({ kind: "preparing", labels: ["clip"] });
    vi.advanceTimersByTime(250);
    m.observe(null);

    const [started, cancelled] = rows();
    expect(started).toMatchObject({ op_state: { state: "Started" } });
    expect(cancelled).toMatchObject({
      level: "info",
      message: "Export cancelled",
      op_state: { state: "Ok" },
    });
    expect(cancelled!.op_id).toBe(started!.op_id);
  });

  it("progress: flushes Started, then one row per tenth, never per update", () => {
    const m = createExportLogMirror();
    m.begin(CTX);
    m.observe({ kind: "starting" });
    const at = (progress: number) =>
      m.observe({
        kind: "progress",
        progress: { progress, currentTimeUs: 0, frame: 0, fps: 0, speed: 0 },
      });

    at(0.01); // flushes Started (before the 250 ms timer) + step 0
    at(0.05); // same tenth — silent
    at(0.12); // step 1
    at(0.13); // same tenth — silent
    m.observe({
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 1 },
    });

    const states = rows().map((r) => r.op_state?.state);
    expect(states).toEqual(["Started", "Progress", "Progress", "Ok"]);
    // Every row of one run shares the op.
    expect(new Set(rows().map((r) => r.op_id)).size).toBe(1);
  });

  it("dismissing a terminal panel (terminal → null) emits nothing", () => {
    const m = createExportLogMirror();
    m.begin(CTX);
    m.observe({ kind: "starting" });
    m.observe({
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 1 },
    });
    vi.mocked(logEmit).mockClear();
    m.observe(null);
    vi.advanceTimersByTime(1000);
    expect(logEmit).not.toHaveBeenCalled();
  });

  it("re-observing the same state reference is a no-op (StrictMode re-run)", () => {
    const m = createExportLogMirror();
    m.begin(CTX);
    const state = {
      kind: "complete",
      payload: { outputPath: CTX.output, durationUs: 1 },
    } as const;
    m.observe({ kind: "starting" });
    m.observe(state);
    const count = rows().length;
    m.observe(state);
    expect(rows()).toHaveLength(count);
  });
});
