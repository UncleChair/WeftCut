import { describe, expect, it, beforeEach } from "vitest";
import {
  registerTransport,
  releaseTransport,
  setTransportPlaying,
  transportPause,
  transportPlay,
  transportSeek,
  usePlaybackStore,
  type TransportHandle,
} from "./playbackStore";

/// Recording fake — the store should delegate verbatim, so the assertions
/// are on the call log, not on any playback side effects.
function fakeTransport(playing = false): {
  handle: TransportHandle;
  calls: string[];
} {
  const calls: string[] = [];
  const handle: TransportHandle = {
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    seek: (tUs: number) => calls.push(`seek:${tUs}`),
    isPlaying: () => playing,
  };
  return { handle, calls };
}

describe("playbackStore", () => {
  beforeEach(() => {
    usePlaybackStore.setState({ transport: null, playing: false });
  });

  it("transport calls are safe no-ops when no preview is mounted", () => {
    expect(() => {
      transportPlay();
      transportPause();
      transportSeek(1_000_000);
    }).not.toThrow();
    expect(usePlaybackStore.getState().playing).toBe(false);
  });

  it("delegates play/pause/seek to the registered transport", () => {
    const { handle, calls } = fakeTransport();
    registerTransport(handle);
    transportPlay();
    transportPause();
    transportSeek(42);
    expect(calls).toEqual(["play", "pause", "seek:42"]);
  });

  it("registerTransport seeds playing from the handle", () => {
    const { handle } = fakeTransport(true);
    registerTransport(handle);
    expect(usePlaybackStore.getState().playing).toBe(true);
  });

  it("setTransportPlaying mirrors the engine's play state", () => {
    const { handle } = fakeTransport();
    registerTransport(handle);
    setTransportPlaying(true);
    expect(usePlaybackStore.getState().playing).toBe(true);
    setTransportPlaying(false);
    expect(usePlaybackStore.getState().playing).toBe(false);
  });

  it("releaseTransport clears the registration and resets playing", () => {
    const { handle, calls } = fakeTransport(true);
    registerTransport(handle);
    releaseTransport(handle);
    expect(usePlaybackStore.getState().transport).toBe(null);
    expect(usePlaybackStore.getState().playing).toBe(false);
    transportPause();
    expect(calls).toEqual([]);
  });

  it("releaseTransport ignores a stale handle after a re-register", () => {
    // Mount ordering safety: if a new preview registered before the old
    // mount's cleanup ran, the stale release must not tear down the live
    // transport.
    const a = fakeTransport();
    const b = fakeTransport();
    registerTransport(a.handle);
    registerTransport(b.handle);
    releaseTransport(a.handle);
    transportPause();
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual(["pause"]);
  });
});
