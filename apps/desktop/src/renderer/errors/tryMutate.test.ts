// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logEmit } from "../ipc";
import { logMutationFailure, refusalText, tryMutate } from "./tryMutate";

vi.mock("../ipc", () => ({ logEmit: vi.fn(() => Promise.resolve()) }));

const logEmitMock = vi.mocked(logEmit);

/// The wire shape a refused command actually arrives in (bridge/ipc.ts →
/// Electron → ts-actor-host's `Error(JSON.stringify(r.error))`).
function wireError(err: Record<string, unknown>): Error {
  return new Error(
    `Error invoking remote method 'backend:invoke': Error: ${JSON.stringify(err)}`,
  );
}

beforeEach(() => {
  logEmitMock.mockClear();
});

describe("tryMutate", () => {
  it("returns true and stays silent on success", async () => {
    expect(await tryMutate(() => Promise.resolve("ok"), "Move layer")).toBe(
      true,
    );
    expect(logEmitMock).not.toHaveBeenCalled();
  });

  it("logs a refusal as one Project/User entry with the curated line", async () => {
    const ok = await tryMutate(
      () => Promise.reject(wireError({ error: "TrackLocked", track: "t-9" })),
      "Move layer",
    );
    expect(ok).toBe(false);
    expect(logEmitMock).toHaveBeenCalledTimes(1);
    const entry = logEmitMock.mock.calls[0]![0];
    expect(entry.level).toBe("error");
    expect(entry.category).toEqual({ kind: "Project" });
    expect(entry.source).toEqual({ kind: "User" });
    expect(entry.message).toBe("#t-9 is locked.");
    expect(entry.i18n_key).toBe("errors.track_locked");
    expect(entry.details).toMatchObject({
      context: "Move layer",
      error: { error: "TrackLocked", track: "t-9" },
    });
  });

  it("suppressed no-ops land at debug level", async () => {
    await tryMutate(
      () => Promise.reject(wireError({ error: "NothingToUndo" })),
      "Undo",
    );
    expect(logEmitMock.mock.calls[0]![0].level).toBe("debug");
  });

  it("non-refusal failures keep a generic error entry", async () => {
    const ok = await tryMutate(
      () => Promise.reject(new Error("disk on fire")),
      "Save project",
    );
    expect(ok).toBe(false);
    const entry = logEmitMock.mock.calls[0]![0];
    expect(entry.level).toBe("error");
    expect(entry.message).toBe(
      "Save project failed: Error: disk on fire",
    );
    expect(entry.i18n_key).toBeUndefined();
  });
});

describe("logMutationFailure / refusalText", () => {
  it("logMutationFailure is the same emission without the wrapper", () => {
    logMutationFailure(wireError({ error: "NothingToRedo" }), "Redo");
    expect(logEmitMock.mock.calls[0]![0]).toMatchObject({
      level: "debug",
      category: { kind: "Project" },
    });
  });

  it("refusalText renders the refusal line for inline slots", () => {
    expect(refusalText(wireError({ error: "TrackLocked", track: "t-9" }))).toBe(
      "#t-9 is locked.",
    );
    expect(refusalText(new Error("plain boom"))).toBe("Error: plain boom");
  });
});
