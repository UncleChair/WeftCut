// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render } from "@testing-library/react";
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
import { formatMediaDuration, MediaDropZone, MediaPool } from "./MediaPool";
import { MEDIA_DRAG_TYPE, useMediaDragStore } from "../timeline/mediaDrag";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
  useMediaDragStore.getState().end();
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
    // The pill is a direct child of the card li (not the thumb) so list
    // mode can flow it inline as an always-visible row control; card modes
    // keep it pinned over the thumbnail's top-left corner via CSS.
    expect(pill?.parentElement?.classList.contains("media-item")).toBe(true);
    expect(pill?.closest(".media-item-thumb")).toBeNull();
    expect(pill?.textContent).toBe("Proxy: Auto");
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

describe("MediaPool card metadata", () => {
  it("always shows type, resolution, and total-minute duration badges", () => {
    const media = makeMedia("long-media", { route: "bypass" });
    media.kind = "Image";
    media.width = 3840;
    media.height = 2160;
    media.duration_us = (61 * 60 + 5) * 1_000_000;

    const { container } = renderPool([media]);
    const thumbnail = container.querySelector(".media-item-thumb");

    expect(container.querySelector(".media-kind")?.textContent).toBe("Image");
    expect(thumbnail?.querySelector(".media-resolution-badge")?.textContent).toBe(
      "3840×2160",
    );
    expect(thumbnail?.querySelector(".media-duration-badge")?.textContent).toBe(
      "61:05",
    );
    expect(container.querySelector(".media-item-info")).toBeNull();
    expect(container.querySelector(".media-item-name")?.textContent).toBe(
      "long-media",
    );
  });

  it("does not wrap total minutes at 60", () => {
    expect(formatMediaDuration((125 * 60 + 9) * 1_000_000)).toBe("125:09");
  });
});

describe("MediaPool drag preview", () => {
  it("suppresses Chromium's snapshot and renders the app-owned preview", () => {
    const { container } = renderPool([
      makeMedia("m-drag", { route: "bypass" }),
    ]);
    const card = container.querySelector(".media-item") as HTMLElement;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      right: 190,
      bottom: 140,
      width: 180,
      height: 120,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      types: [],
      effectAllowed: "none",
      setData: vi.fn(),
      setDragImage: vi.fn(),
    } as unknown as DataTransfer;
    const dragStart = createEvent.dragStart(card, { dataTransfer });
    Object.defineProperties(dragStart, {
      clientX: { value: 40 },
      clientY: { value: 50 },
    });

    fireEvent(card, dragStart);

    expect(dataTransfer.setData).toHaveBeenCalledWith(
      MEDIA_DRAG_TYPE,
      expect.any(String),
    );
    expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
    const preview = document.querySelector(
      '[data-testid="media-drag-preview"]',
    ) as HTMLElement;
    expect(preview).not.toBeNull();
    expect(preview.style.width).toBe("180px");
    expect(preview.style.height).toBe("120px");
    expect(preview.style.transform).toBe("translate3d(10px, 20px, 0)");
  });
});

describe("Media Pool drop isolation", () => {
  it("accepts OS Files without treating business or Panel drags as imports", () => {
    const { container } = render(
      <MediaDropZone>
        <span>contents</span>
      </MediaDropZone>,
    );
    const zone = container.querySelector(".media-pool") as HTMLElement;

    const mediaDrag = createEvent.dragEnter(zone, {
      dataTransfer: { types: [MEDIA_DRAG_TYPE] },
    });
    fireEvent(zone, mediaDrag);
    expect(mediaDrag.defaultPrevented).toBe(false);
    expect(container.querySelector(".media-pool-drop-overlay")).toBeNull();

    const panelDrag = createEvent.dragEnter(zone, {
      dataTransfer: { types: ["text/plain"] },
    });
    fireEvent(zone, panelDrag);
    expect(panelDrag.defaultPrevented).toBe(false);
    expect(container.querySelector(".media-pool-drop-overlay")).toBeNull();

    const filesDrag = createEvent.dragEnter(zone, {
      dataTransfer: { types: ["Files"] },
    });
    fireEvent(zone, filesDrag);
    expect(filesDrag.defaultPrevented).toBe(true);
    expect(container.querySelector(".media-pool-drop-overlay")).not.toBeNull();

    const filesDrop = createEvent.drop(zone, {
      dataTransfer: { types: ["Files"] },
    });
    fireEvent(zone, filesDrop);
    expect(filesDrop.defaultPrevented).toBe(true);
    expect(container.querySelector(".media-pool-drop-overlay")).toBeNull();
  });
});
