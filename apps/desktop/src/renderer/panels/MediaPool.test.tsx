// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n"; // initialize i18next so useTranslation() resolves (keys land in Task 10)

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, generateQuickProxy: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../state/proxyPreferenceStore", async (importActual) => {
  const actual = await importActual<typeof import("../state/proxyPreferenceStore")>();
  return { ...actual, setProxyOverride: vi.fn().mockResolvedValue(undefined) };
});

import { generateQuickProxy, type MediaSummary } from "../ipc";
import { useProxyPrefStore, setProxyOverride } from "../state/proxyPreferenceStore";
import { MediaPool } from "./MediaPool";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
});

// kind: "Audio" sidesteps mediaReadiness's Video-only proxy-pending branch
// and MediaThumbnail's video-thumbnail IPC fetch — neither is relevant to
// the pill, and both would otherwise need extra mocking.
function makeMedia(id: string, route: MediaSummary["decode_route"]): MediaSummary {
  return {
    id,
    label: id,
    path: `/media/${id}.mp4`,
    kind: "Audio",
    duration_us: 1_000_000,
    width: null,
    height: null,
    size_bytes: 1024,
    available: true,
    decode_route: route,
    codec: null,
    pix_fmt: null,
  };
}

function renderPool(media: MediaSummary[]) {
  return render(
    <MediaPool
      media={media}
      importing={new Set()}
      proxyState={new Map()}
      previewDecodable={new Set()}
      fpsNum={30}
      fpsDen={1}
      onCancelImport={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("MediaPool proxy pill", () => {
  it("renders no pill for a Bypass-route media", () => {
    renderPool([makeMedia("m-bypass", { route: "bypass" })]);
    expect(document.querySelector(".media-proxy-pill")).toBeNull();
  });

  it("clicking a non-bypass pill in auto state sets the override to true, and also kicks a build when no quick proxy exists", async () => {
    renderPool([makeMedia("m1", { route: "direct-export", quick_proxy: null })]);
    const pill = document.querySelector(".media-proxy-pill.is-auto");
    expect(pill).not.toBeNull();
    await userEvent.click(pill as HTMLElement);

    expect(generateQuickProxy).toHaveBeenCalledWith("m1");
    expect(setProxyOverride).toHaveBeenCalledWith("m1", true);
  });

  it("does not kick a build from auto->proxy when a quick proxy already exists", async () => {
    renderPool([
      makeMedia("m2", { route: "direct-export", quick_proxy: "/proxies/m2.mp4" }),
    ]);
    const pill = document.querySelector(".media-proxy-pill.is-auto");
    await userEvent.click(pill as HTMLElement);

    expect(generateQuickProxy).not.toHaveBeenCalled();
    expect(setProxyOverride).toHaveBeenCalledWith("m2", true);
  });

  it("clicking again from an existing proxy override (true) cycles to force-original (false)", async () => {
    useProxyPrefStore.setState({ overrides: { m3: true } });
    renderPool([makeMedia("m3", { route: "direct-export", quick_proxy: null })]);
    const pill = document.querySelector(".media-proxy-pill.is-proxy");
    expect(pill).not.toBeNull();
    await userEvent.click(pill as HTMLElement);

    expect(setProxyOverride).toHaveBeenCalledWith("m3", false);
    // Already has a proxy override going to false is not the no-proxy build
    // path (that's only auto(undefined)->true); guard against a regression
    // that fires a build on every click.
    expect(generateQuickProxy).not.toHaveBeenCalled();
  });
});
