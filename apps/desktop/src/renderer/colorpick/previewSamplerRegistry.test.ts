import { describe, expect, it } from "vitest";
import {
  clearPreviewSampler,
  getPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "./previewSamplerRegistry";

const fake = (): PreviewSampler => ({
  captureFrame: async () => ({ pixels: new Uint8Array(4), width: 1, height: 1 }),
  mapClientToComposition: () => null,
  canvasRect: () => null,
});

describe("previewSamplerRegistry", () => {
  it("register/get/clear; clear is identity-guarded", () => {
    const a = fake();
    const b = fake();
    registerPreviewSampler(a);
    expect(getPreviewSampler()).toBe(a);
    registerPreviewSampler(b); // re-register replaces (StrictMode re-mount)
    clearPreviewSampler(a);    // stale unmount must NOT tear down the live one
    expect(getPreviewSampler()).toBe(b);
    clearPreviewSampler(b);
    expect(getPreviewSampler()).toBeNull();
  });
});
