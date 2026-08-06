// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n"; // initialize i18next so useTranslation() resolves

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    generateQuickProxy: vi.fn().mockResolvedValue(undefined),
    analyzeShots: vi.fn().mockResolvedValue(3),
    getMediaThumbnail: vi.fn().mockRejectedValue("not_ready"),
    removeMedia: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/bridge/events", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../state/proxyPreferenceStore", async (importActual) => {
  const actual = await importActual<typeof import("../state/proxyPreferenceStore")>();
  return { ...actual, setProxyOverride: vi.fn().mockResolvedValue(undefined) };
});

import {
  analyzeShots,
  generateQuickProxy,
  removeMedia,
  type MediaSummary,
  type TrackSummary,
} from "../ipc";
import { useProxyPrefStore, setProxyOverride } from "../state/proxyPreferenceStore";
import { formatMediaDuration, MediaDropZone, MediaPool } from "./MediaPool";
import { type OptimizeInfo } from "./importOptimize";
import { MEDIA_DRAG_TYPE, useMediaDragStore } from "../timeline/mediaDrag";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProxyPrefStore.setState({ preferProxies: false, overrides: {} });
  useMediaDragStore.getState().end();
});

// Audio keeps most tests outside mediaReadiness's Video-only proxy-pending
// branch. Tests for Video-only menu actions opt in explicitly.
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

function renderPool(
  media: MediaSummary[],
  tracks: TrackSummary[] = [],
  extra: Partial<React.ComponentProps<typeof MediaPool>> = {},
) {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  const onImportMedia = vi.fn().mockResolvedValue(undefined);
  return {
    ...render(
      <MediaPool
        media={media}
        tracks={tracks}
        importing={new Set()}
        proxyState={new Map()}
        previewDecodable={new Set()}
        fpsNum={30}
        fpsDen={1}
        onCancelImport={vi.fn().mockResolvedValue(undefined)}
        onMutated={onMutated}
        onImportMedia={onImportMedia}
        {...extra}
      />,
    ),
    onMutated,
    onImportMedia,
  };
}

function makeReferencingTrack(mediaId: string): TrackSummary {
  return {
    id: "track-1",
    kind: "Audio",
    label: "Dialogue",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-1",
        label: "Interview clip",
        t_start_us: 2_000_000,
        t_end_us: 3_000_000,
        kind: "Audio",
        color_hint: "audio",
        enabled: true,
        locked: false,
        effects: [],
        params: {
          kind: "Audio",
          media_id: mediaId,
          media_label: mediaId,
          src_in_us: 0,
          src_out_us: 1_000_000,
          gain_db: { mode: "Static", value: 0 },
          pan: { mode: "Static", value: 0 },
          fade_in_us: 0,
          fade_out_us: 0,
          mute: false,
          role: "dialogue",
        },
      },
    ],
  };
}

function openMediaMenu(mediaId: string): HTMLElement {
  const card = document.querySelector(
    `[data-media-id="${mediaId}"]`,
  ) as HTMLElement;
  fireEvent.contextMenu(card, { clientX: 80, clientY: 90 });
  return card;
}

describe("MediaPool import button", () => {
  it("invokes the import callback (same action as the menu's Import)", async () => {
    const user = userEvent.setup();
    const { onImportMedia } = renderPool([
      makeMedia("m-import", { route: "bypass" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Import media…" }));
    expect(onImportMedia).toHaveBeenCalledOnce();
  });

  it("shows a large import CTA in the empty state", async () => {
    const user = userEvent.setup();
    const { onImportMedia } = renderPool([]);
    await user.click(screen.getByRole("button", { name: "Import media…" }));
    expect(onImportMedia).toHaveBeenCalledOnce();
  });
});

describe("MediaPool context menu", () => {
  it("keeps card chrome action-free and omits proxy choices for Bypass media", () => {
    const { container } = renderPool([
      makeMedia("m-bypass", { route: "bypass" }),
    ]);

    expect(container.querySelector(".media-proxy-pill")).toBeNull();
    expect(container.querySelector(".media-analyze-shots")).toBeNull();
    expect(container.querySelector(".media-remove-button")).toBeNull();

    openMediaMenu("m-bypass");
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(
      screen.getByRole("menuitem", { name: "Remove from media pool" }),
    ).toBeTruthy();
  });

  it("lays out one proxy radio group and selecting Proxy builds a missing quick proxy", async () => {
    const user = userEvent.setup();
    renderPool([makeMedia("m1", { route: "direct-export", quick_proxy: null })]);
    openMediaMenu("m1");

    const radioGroup = document.querySelector(".media-proxy-radio-group");
    expect(radioGroup).not.toBeNull();
    expect(radioGroup?.children).toHaveLength(3);
    expect(
      screen
        .getByRole("menuitemradio", { name: "Auto" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(
      screen.getByRole("menuitemradio", { name: "Proxy" }),
    );

    expect(generateQuickProxy).toHaveBeenCalledWith("m1");
    expect(setProxyOverride).toHaveBeenCalledWith("m1", true);
  });

  it("does not rebuild when selecting Proxy with a landed quick proxy", async () => {
    const user = userEvent.setup();
    renderPool([
      makeMedia("m2", { route: "direct-export", quick_proxy: "/proxies/m2.mp4" }),
    ]);
    openMediaMenu("m2");
    await user.click(
      screen.getByRole("menuitemradio", { name: "Proxy" }),
    );

    expect(generateQuickProxy).not.toHaveBeenCalled();
    expect(setProxyOverride).toHaveBeenCalledWith("m2", true);
  });

  it("shows the current override and allows choosing the original explicitly", async () => {
    const user = userEvent.setup();
    useProxyPrefStore.setState({ overrides: { m3: true } });
    renderPool([makeMedia("m3", { route: "direct-export", quick_proxy: null })]);
    openMediaMenu("m3");

    expect(
      screen
        .getByRole("menuitemradio", { name: "Proxy" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(
      screen.getByRole("menuitemradio", { name: "Original" }),
    );

    expect(setProxyOverride).toHaveBeenCalledWith("m3", false);
    expect(generateQuickProxy).not.toHaveBeenCalled();
  });

  it("moves shot analysis into the menu and supports the keyboard menu key", async () => {
    const user = userEvent.setup();
    const media = makeMedia("video-1", { route: "bypass" });
    media.kind = "Video";
    const { container } = renderPool([media]);
    const card = container.querySelector(".media-item") as HTMLElement;

    fireEvent.keyDown(card, { key: "F10", shiftKey: true });
    await user.click(
      screen.getByRole("menuitem", { name: "Analyze shots" }),
    );

    expect(analyzeShots).toHaveBeenCalledWith("video-1");
    expect(container.querySelector(".media-analyze-shots")).toBeNull();
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

// The badges must say "usable now, optimizing in background" without ever
// implying the clip is unusable.
describe("MediaPool optimize badges", () => {
  const optimize = (
    id: string,
    status: OptimizeInfo["status"],
  ): ReadonlyMap<string, OptimizeInfo> =>
    new Map([[id, { status, reason: { key: "reason_10bit", codec: "HEVC" } }]]);

  it("marks a bridged clip with the corner dot and keeps it draggable", () => {
    const media = makeMedia("bridged-clip", { route: "bypass" });
    const { container } = renderPool([media], [], {
      optimizeById: optimize("bridged-clip", "bridged"),
    });

    expect(container.querySelector(".media-optimizing-dot")).not.toBeNull();
    // The whole point of the dot: it reports background work WITHOUT
    // withdrawing the clip. A regression that ties it to readiness would
    // silently make optimizing clips undraggable.
    expect(
      container.querySelector<HTMLElement>("[data-media-id='bridged-clip']")
        ?.draggable,
    ).toBe(true);
    expect(container.querySelector(".media-proxy-pending-badge")).toBeNull();
  });

  it("shows only the blocking badge for a clip with no preview source yet", () => {
    const media = makeMedia("waiting-clip", {
      route: "proxied",
      quick_proxy: null,
      full_proxy: null,
      format_version: 0,
    });
    media.kind = "Video";
    const { container } = renderPool([media], [], {
      optimizeById: optimize("waiting-clip", "transcoding"),
    });

    expect(container.querySelector(".media-proxy-pending-badge")).not.toBeNull();
    // Not both: the centred badge already says "you can't use this yet".
    expect(container.querySelector(".media-optimizing-dot")).toBeNull();
  });

  it("stays clean for a settled clip", () => {
    const media = makeMedia("settled-clip", { route: "bypass" });
    const { container } = renderPool([media], [], {
      optimizeById: optimize("settled-clip", "direct"),
    });

    expect(container.querySelector(".media-optimizing-dot")).toBeNull();
    expect(container.querySelector(".media-proxy-pending-badge")).toBeNull();
    expect(container.querySelector(".media-proxy-failed-badge")).toBeNull();
  });
});

describe("MediaPool removal", () => {
  it("opens guarded removal from the context menu for unused media", async () => {
    const user = userEvent.setup();
    const { onMutated } = renderPool([
      makeMedia("unused-media", { route: "bypass" }),
    ]);

    openMediaMenu("unused-media");
    await user.click(
      screen.getByRole("menuitem", {
        name: "Remove from media pool",
      }),
    );

    expect(
      screen.getByText("Remove “unused-media” from this project?"),
    ).toBeTruthy();
    expect(
      screen.getByText(/source file will stay on disk/i),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(removeMedia).toHaveBeenCalledWith("unused-media", false);
      expect(onMutated).toHaveBeenCalledOnce();
    });
  });

  it("lists timeline references before offering the explicit force path", async () => {
    const user = userEvent.setup();
    const media = makeMedia("used-media", { route: "bypass" });
    const { onMutated } = renderPool(
      [media],
      [makeReferencingTrack(media.id)],
    );

    openMediaMenu("used-media");
    await user.click(
      screen.getByRole("menuitem", {
        name: "Remove from media pool",
      }),
    );

    expect(screen.getByText("Media is in use")).toBeTruthy();
    expect(screen.getByText("Interview clip")).toBeTruthy();
    expect(screen.getByText("Dialogue · 00:00:02:00")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Remove media + 1 layer" }),
    );

    await waitFor(() => {
      expect(removeMedia).toHaveBeenCalledWith("used-media", true);
      expect(onMutated).toHaveBeenCalledOnce();
    });
  });

  it("upgrades a stale guarded confirmation when the backend reports MediaInUse", async () => {
    const user = userEvent.setup();
    vi.mocked(removeMedia)
      .mockRejectedValueOnce(
        new Error(
          JSON.stringify({
            error: "MediaInUse",
            media: "raced-media",
            referenced_by: ["late-layer"],
          }),
        ),
      )
      .mockResolvedValueOnce(undefined);
    const { onMutated } = renderPool([
      makeMedia("raced-media", { route: "bypass" }),
    ]);

    openMediaMenu("raced-media");
    await user.click(
      screen.getByRole("menuitem", {
        name: "Remove from media pool",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));

    const forceButton = await screen.findByRole("button", {
      name: "Remove media + 1 layer",
    });
    expect(screen.getByText("Layer late-lay")).toBeTruthy();
    expect(removeMedia).toHaveBeenNthCalledWith(1, "raced-media", false);

    await user.click(forceButton);
    await waitFor(() => {
      expect(removeMedia).toHaveBeenNthCalledWith(2, "raced-media", true);
      expect(onMutated).toHaveBeenCalledOnce();
    });
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
