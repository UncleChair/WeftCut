import { describe, expect, test, vi } from "vitest";
import {
  handleDecodeError,
  type DecodeErrorAction,
} from "./decoderFallback";

const baseArgs = {
  mediaId: "media-1",
  log: () => {},
};

describe("handleDecodeError", () => {
  test("first-frame HW error downgrades to software", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("hardware decode failed"),
      outputFrameCount: 0,
      alreadyDowngraded: false,
    });
    expect(action).toEqual<DecodeErrorAction>({ kind: "downgrade-to-software" });
  });

  test("error after frames have flowed does not downgrade", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("transient decode glitch"),
      outputFrameCount: 42,
      alreadyDowngraded: false,
    });
    expect(action.kind).toBe("log-only");
  });

  test("already-downgraded handle never downgrades again", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("software decode also failed"),
      outputFrameCount: 0,
      alreadyDowngraded: true,
    });
    expect(action.kind).toBe("log-only");
  });

  test("inactivity message triggers rebuild path", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("Codec reclaimed due to inactivity"),
      outputFrameCount: 100,
      alreadyDowngraded: false,
    });
    expect(action).toEqual<DecodeErrorAction>({ kind: "inactivity-rebuild" });
  });

  test("inactivity precedence: takes precedence over first-frame downgrade", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("Codec reclaimed due to inactivity"),
      outputFrameCount: 0,
      alreadyDowngraded: false,
    });
    expect(action.kind).toBe("inactivity-rebuild");
  });

  test("inactivity warning cites the source mediaId", () => {
    const log = vi.fn();
    handleDecodeError({
      ...baseArgs,
      log,
      err: new Error("Codec reclaimed due to inactivity"),
      outputFrameCount: 1,
      alreadyDowngraded: false,
      mediaId: "clip-xyz",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/inactivity/i);
    expect(log.mock.calls[0]![0]).toMatch(/clip-xyz/);
  });

  test("downgrade and log-only actions do not emit a LogBus warning", () => {
    const log = vi.fn();
    handleDecodeError({
      ...baseArgs,
      log,
      err: new Error("hw fail"),
      outputFrameCount: 0,
      alreadyDowngraded: false,
    });
    handleDecodeError({
      ...baseArgs,
      log,
      err: new Error("mid-stream glitch"),
      outputFrameCount: 50,
      alreadyDowngraded: false,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
