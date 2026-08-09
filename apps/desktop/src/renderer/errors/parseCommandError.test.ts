import { describe, expect, it } from "vitest";
import { parseCommandError } from "./parseCommandError";

describe("parseCommandError", () => {
  // The exact wrapping Electron 42 produces for a rejected `backend:invoke`.
  // The parser must NOT depend on this prefix's wording (it slices from the
  // first `{`); the fixture is a regression canary for the real wire shape —
  // if an Electron major changes the framing, this is the test that tells us.
  it("parses the CommandError riding an Electron-wrapped IPC rejection", () => {
    const err = new Error(
      "Error invoking remote method 'backend:invoke': Error: " +
        '{"error":"TrackLocked","track":"3f9c12ab-0000-4000-8000-000000000001"}',
    );
    expect(parseCommandError(err)).toEqual({
      error: "TrackLocked",
      track: "3f9c12ab-0000-4000-8000-000000000001",
    });
  });

  it("parses a bare Error(JSON.stringify(err)) with no IPC prefix", () => {
    const err = new Error('{"error":"NothingToUndo"}');
    expect(parseCommandError(err)).toEqual({ error: "NothingToUndo" });
  });

  it("keeps a ValidationFailed detail nested and intact", () => {
    const detail = {
      rule: "LayerOverlap",
      track: "t-1",
      a: "layer-a",
      a_start: 0,
      a_end: 2_000_000,
      b: "layer-b",
      b_start: 1_000_000,
      b_end: 3_000_000,
    };
    const err = new Error(
      "Error invoking remote method 'backend:invoke': Error: " +
        JSON.stringify({ error: "ValidationFailed", detail }),
    );
    const parsed = parseCommandError(err);
    expect(parsed?.error).toBe("ValidationFailed");
    expect(parsed && "detail" in parsed ? parsed.detail : null).toEqual(detail);
  });

  it("accepts a raw string rejection", () => {
    expect(parseCommandError('{"error":"NothingToRedo"}')).toEqual({
      error: "NothingToRedo",
    });
  });

  it("returns null for prose without JSON", () => {
    expect(parseCommandError(new Error("network hiccup"))).toBeNull();
  });

  it("returns null for malformed JSON after the first brace", () => {
    expect(parseCommandError(new Error("boom {not json"))).toBeNull();
  });

  it("returns null for JSON without a string `error` discriminant", () => {
    expect(parseCommandError(new Error('{"rule":"LayerOverlap"}'))).toBeNull();
    expect(parseCommandError(new Error('{"error":42}'))).toBeNull();
  });

  it("returns null for non-Error, non-string rejections", () => {
    expect(parseCommandError({ error: "TrackLocked" })).toBeNull();
    expect(parseCommandError(undefined)).toBeNull();
  });
});
