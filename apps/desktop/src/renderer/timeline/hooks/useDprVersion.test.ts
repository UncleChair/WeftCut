// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDprVersion } from "./useDprVersion";

describe("useDprVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing when window.matchMedia is unavailable", () => {
    const original = window.matchMedia;
    Reflect.deleteProperty(window, "matchMedia");
    try {
      const { result } = renderHook(() => useDprVersion());
      expect(result.current).toBe(0);
    } finally {
      if (original) {
        Object.defineProperty(window, "matchMedia", { value: original, configurable: true });
      }
    }
  });

  it("bumps version on a dpr change, re-arms a fresh query embedding the new dpr, and removes the active listener on unmount", async () => {
    const queries: string[] = [];
    const listenersByQuery = new Map<string, Set<() => void>>();
    const removeEventListenerSpy = vi.fn();
    const fakeMatchMedia = vi.fn((query: string) => {
      queries.push(query);
      const listeners = new Set<() => void>();
      listenersByQuery.set(query, listeners);
      return {
        matches: true,
        media: query,
        addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (type: string, cb: () => void) => {
          removeEventListenerSpy(type, cb);
          listeners.delete(cb);
        },
      } as unknown as MediaQueryList;
    });
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { value: fakeMatchMedia, configurable: true });

    try {
      const { result, unmount } = renderHook(() => useDprVersion());
      expect(result.current).toBe(0);
      await waitFor(() => expect(queries.length).toBe(1));
      const firstQuery = queries[0]!;
      const firstListenerSet = listenersByQuery.get(firstQuery)!;

      const originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
      Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
      try {
        act(() => {
          for (const cb of firstListenerSet) cb();
        });

        await waitFor(() => expect(result.current).toBe(1));
        await waitFor(() => expect(queries.length).toBe(2));
        const secondQuery = queries[1]!;
        // The re-armed query must be a DIFFERENT string built from the NEW dpr.
        expect(secondQuery).not.toBe(firstQuery);
        expect(secondQuery).toContain("3dppx");
        // The old listener must have been torn down (re-arm, not accumulate).
        expect(firstListenerSet.size).toBe(0);

        // A5-M3: unmount must remove the currently-armed (second) listener,
        // not leak it — assert removeEventListener fires with that handler.
        const secondListenerSet = listenersByQuery.get(secondQuery)!;
        const [armedHandler] = secondListenerSet;
        unmount();
        expect(removeEventListenerSpy).toHaveBeenCalledWith("change", armedHandler);
        expect(secondListenerSet.size).toBe(0);
      } finally {
        if (originalDpr) {
          Object.defineProperty(window, "devicePixelRatio", originalDpr);
        } else {
          Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
        }
      }
    } finally {
      if (original) {
        Object.defineProperty(window, "matchMedia", { value: original, configurable: true });
      } else {
        Reflect.deleteProperty(window, "matchMedia");
      }
    }
  });
});
