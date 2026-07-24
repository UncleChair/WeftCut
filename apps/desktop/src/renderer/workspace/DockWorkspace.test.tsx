// @vitest-environment jsdom

import { StrictMode, type ComponentProps, type ComponentType } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DockviewApi } from "dockview-react";

const dockHarness = vi.hoisted(() => ({
  api: null as unknown,
  captures: [] as Record<string, unknown>[],
  readyCalls: 0,
  renderWatermark: false,
  headerApi: null as unknown,
  contentApi: null as unknown,
  contentKind: null as string | null,
}));

const previewHarness = vi.hoisted(() => ({
  sequence: 0,
  mounts: 0,
  unmounts: 0,
}));

vi.mock("dockview-react", async () => {
  const React = await import("react");
  return {
    DockviewReact: (props: Record<string, unknown>) => {
      dockHarness.captures.push(props);
      React.useEffect(() => {
        dockHarness.readyCalls += 1;
        (props.onReady as (event: { api: unknown }) => void)({
          api: dockHarness.api,
        });
      }, [props.onReady]);
      const Watermark = props.watermarkComponent as
        | ComponentType
        | undefined;
      const tabComponents = props.tabComponents as
        | Record<string, ComponentType<{ api: unknown }>>
        | undefined;
      const Tab = tabComponents?.["weftcut-tab"];
      const components = props.components as
        | Record<string, ComponentType<{ api: unknown; params: { kind: string } }>>
        | undefined;
      const Content = components?.["weftcut-panel"];
      return (
        <div data-testid="dockview">
          {dockHarness.renderWatermark && Watermark ? <Watermark /> : null}
          {dockHarness.headerApi && Tab ? (
            <Tab api={dockHarness.headerApi} />
          ) : null}
          {dockHarness.contentApi && dockHarness.contentKind && Content ? (
            <Content
              api={dockHarness.contentApi}
              params={{ kind: dockHarness.contentKind }}
            />
          ) : null}
        </div>
      );
    },
  };
});

vi.mock("../ipc", () => ({ importCancel: vi.fn() }));
vi.mock("../timeline/Timeline", () => ({ Timeline: () => null }));
vi.mock("../app/PreviewSection", async () => {
  const React = await import("react");
  return {
    PreviewSection: ({ visible }: { visible: boolean }) => {
      const [resource] = React.useState(
        () => `preview-resource-${++previewHarness.sequence}`,
      );
      React.useEffect(() => {
        previewHarness.mounts += 1;
        return () => {
          previewHarness.unmounts += 1;
        };
      }, []);
      return (
        <div
          data-testid="preview-probe"
          data-resource={resource}
          data-visible={visible ? "true" : "false"}
        />
      );
    },
  };
});
vi.mock("../panels/MediaPool", () => ({
  MediaDropZone: ({ children }: { children: React.ReactNode }) => children,
  MediaPool: () => null,
}));
vi.mock("../panels/AttributePanel", () => ({ AttributePanel: () => null }));
vi.mock("../panels/CaptionPanel", () => ({ CaptionPanel: () => null }));
vi.mock("../panels/EffectPanel", () => ({ EffectPanel: () => null }));
vi.mock("../panels/NearbyPanel", () => ({ NearbyPanel: () => null }));
vi.mock("../panels/RoleMixerPanel", () => ({ RoleMixerPanel: () => null }));
vi.mock("../state/playheadStore", () => ({
  usePlayheadTimeUsThrottled: () => 0,
}));

import {
  DockWorkspace,
  type DockPanelContracts,
} from "./DockWorkspace";
import { DOCK_COMPONENT_ID, DOCK_TAB_COMPONENT_ID } from "./panelRegistry";

afterEach(() => cleanup());

function strictModeApi() {
  const panels = new Map<
    string,
    {
      id: string;
      group: {
        panels: unknown[];
        model: { header: { hidden: boolean } };
        api: { isMaximized(): boolean };
      };
      api: {
        id: string;
        title: string;
        group: { panels: unknown[] };
        setActive: ReturnType<typeof vi.fn>;
        setTitle: ReturnType<typeof vi.fn>;
        setSize: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        maximize: ReturnType<typeof vi.fn>;
      };
    }
  >();
  const groups: { panels: unknown[]; model: { header: { hidden: boolean } } }[] =
    [];
  const addPanel = vi.fn((options: Record<string, unknown>) => {
    const position = options.position as
      | { referencePanel?: string; direction?: string }
      | undefined;
    const reference = position?.referencePanel
      ? panels.get(position.referencePanel)
      : undefined;
    const group = position?.direction === "within" && reference
      ? reference.group
      : {
          panels: [] as unknown[],
          model: { header: { hidden: false } },
          api: { isMaximized: () => false },
        };
    if (!groups.includes(group)) groups.push(group);
    const panel = {
      id: String(options.id),
      group,
      api: {} as {
        id: string;
        title: string;
        group: { panels: unknown[] };
        setActive: ReturnType<typeof vi.fn>;
        setTitle: ReturnType<typeof vi.fn>;
        setSize: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        maximize: ReturnType<typeof vi.fn>;
      },
    };
    panel.api = {
      id: panel.id,
      title: String(options.title ?? panel.id),
      group,
      setActive: vi.fn(),
      setTitle: vi.fn((title: string) => {
        panel.api.title = title;
      }),
      setSize: vi.fn(),
      close: vi.fn(() => {
        panels.delete(panel.id);
        const index = group.panels.indexOf(panel);
        if (index >= 0) group.panels.splice(index, 1);
      }),
      maximize: vi.fn(),
    };
    group.panels.push(panel);
    panels.set(panel.id, panel);
    return panel;
  });
  const overlayDisposers: ReturnType<typeof vi.fn>[] = [];
  const onWillShowOverlay = vi.fn(() => {
    const dispose = vi.fn();
    overlayDisposers.push(dispose);
    return { dispose };
  });
  const event = vi.fn(() => ({ dispose: vi.fn() }));
  const clear = vi.fn(() => {
    panels.clear();
    groups.splice(0);
  });
  const toJSON = vi.fn(() => ({
    grid: {
      root: {
        type: "branch",
        data: groups.map((group, index) => {
          const views = group.panels.map((candidate) =>
            String((candidate as { id: string }).id),
          );
          return {
            type: "leaf",
            size: 100,
            data: {
              id: `test-group-${index}`,
              views,
              activeView: views[0],
            },
          };
        }),
        size: 100,
      },
      orientation: "HORIZONTAL",
      width: 1_000,
      height: 800,
    },
    panels: Object.fromEntries([...panels.keys()].map((id) => [id, { id }])),
  }));
  const fromJSON = vi.fn((data: unknown) => {
    clear();
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const candidate = node as { type?: string; data?: unknown };
      if (candidate.type === "branch") {
        for (const child of (candidate.data as unknown[]) ?? []) walk(child);
        return;
      }
      const views = (candidate.data as { views?: string[] } | undefined)?.views ?? [];
      let reference: string | undefined;
      for (const id of views) {
        addPanel({
          id,
          title: id,
          ...(reference
            ? { position: { referencePanel: reference, direction: "within" } }
            : {}),
        });
        reference ??= id;
      }
    };
    walk((data as { grid?: { root?: unknown } })?.grid?.root);
  });
  const api = {
    width: 1_000,
    height: 800,
    get totalPanels() {
      return panels.size;
    },
    get panels() {
      return [...panels.values()];
    },
    get groups() {
      return groups;
    },
    getPanel: (id: string) => panels.get(id),
    addPanel,
    onWillShowOverlay,
    onWillDrop: event,
    onDidLayoutChange: event,
    onDidActivePanelChange: event,
    onDidMaximizedGroupChange: event,
    hasMaximizedGroup: vi.fn(() => false),
    exitMaximizedGroup: vi.fn(),
    clear,
    toJSON,
    fromJSON,
  } as unknown as DockviewApi;
  return {
    api,
    panels,
    addPanel,
    fromJSON,
    onWillShowOverlay,
    overlayDisposers,
  };
}

const contracts: DockPanelContracts = {
  summary: null,
  previewRef: { current: null },
  paused: true,
  onPausedChange: vi.fn(),
  onSeek: vi.fn(),
  onTogglePlay: vi.fn(),
  previewDecodableOf: () => false,
  revealedTrackId: null,
  keybindings: {},
  bladeMode: false,
  importingMediaIds: new Set(),
  proxyState: new Map(),
  previewDecodableMediaIds: new Set(),
  onExitBlade: vi.fn(),
  onMutated: async () => {},
  selectedLayerId: null,
  onSelectLayer: vi.fn(),
  onRevealTrack: vi.fn(),
};

beforeEach(() => {
  dockHarness.captures.length = 0;
  dockHarness.readyCalls = 0;
  dockHarness.renderWatermark = false;
  dockHarness.headerApi = null;
  dockHarness.contentApi = null;
  dockHarness.contentKind = null;
  previewHarness.sequence = 0;
  previewHarness.mounts = 0;
  previewHarness.unmounts = 0;
});

function visibilityApi(initial: boolean) {
  let visible = initial;
  const listeners = new Set<() => void>();
  const dispose = vi.fn((listener: () => void) => listeners.delete(listener));
  const api = {
    id: "preview",
    get isVisible() {
      return visible;
    },
    onDidVisibilityChange(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => dispose(listener) };
    },
  };
  return {
    api,
    listenerCount: () => listeners.size,
    setVisible(next: boolean) {
      visible = next;
      for (const listener of listeners) listener();
    },
    dispose,
  };
}

describe("DockWorkspace React integration", () => {
  it("constructs one adapter layout and one DnD subscription under StrictMode", () => {
    const dock = strictModeApi();
    dockHarness.api = dock.api;

    render(
      <StrictMode>
        <DockWorkspace contracts={contracts} />
      </StrictMode>,
    );

    // StrictMode intentionally repeats effect setup, while the WeftCut
    // adapter recognizes the same API and leaves registration idempotent.
    expect(dockHarness.readyCalls).toBe(2);
    expect(dock.addPanel).toHaveBeenCalledTimes(6);
    expect(dock.panels.size).toBe(6);
    // StrictMode tears the first ready effect down and recreates it. Each API
    // lifetime has exactly one subscription; the first is disposed before the
    // second becomes live.
    expect(dock.onWillShowOverlay).toHaveBeenCalledTimes(2);
    expect(dock.overlayDisposers[0]).toHaveBeenCalledOnce();

    const props = dockHarness.captures.at(-1) as unknown as ComponentProps<
      typeof DockWorkspace
    > & {
      components: Record<string, unknown>;
      tabComponents: Record<string, unknown>;
      disableFloatingGroups: boolean;
      dndStrategy: string;
      keyboardNavigation: boolean;
      announcements: boolean;
    };
    expect(Object.keys(props.components)).toEqual([DOCK_COMPONENT_ID]);
    expect(Object.keys(props.tabComponents)).toEqual([DOCK_TAB_COMPONENT_ID]);
    expect(props.disableFloatingGroups).toBe(true);
    expect(props.dndStrategy).toBe("html5");
    expect(props.keyboardNavigation).toBe(true);
    expect(props.announcements).toBe(true);
  });

  it("publishes Dockview visibility without remounting an always-rendered Preview", () => {
    const dock = strictModeApi();
    const visibility = visibilityApi(true);
    dockHarness.api = dock.api;
    dockHarness.contentApi = visibility.api;
    dockHarness.contentKind = "preview";

    const view = render(
      <StrictMode>
        <DockWorkspace contracts={contracts} />
      </StrictMode>,
    );

    const probe = screen.getByTestId("preview-probe");
    const resource = probe.dataset.resource;
    expect(probe.dataset.visible).toBe("true");
    expect(visibility.listenerCount()).toBe(1);

    act(() => visibility.setVisible(false));
    expect(screen.getByTestId("preview-probe").dataset.visible).toBe("false");
    expect(screen.getByTestId("preview-probe").dataset.resource).toBe(resource);
    expect(visibility.listenerCount()).toBe(1);

    act(() => visibility.setVisible(true));
    expect(screen.getByTestId("preview-probe").dataset.resource).toBe(resource);

    view.unmount();
    expect(visibility.listenerCount()).toBe(0);
    expect(previewHarness.unmounts).toBe(previewHarness.mounts);
  });

  it("closes and maximizes from the tab chrome", () => {
    const dock = strictModeApi();
    dockHarness.api = dock.api;
    dockHarness.headerApi = {
      id: "effect",
      title: "Effect",
      group: { panels: [{ id: "attribute" }, { id: "effect" }] },
    };

    render(<DockWorkspace contracts={contracts} />);

    const effect = dock.panels.get("effect");
    fireEvent.doubleClick(screen.getByTitle("Move Effect"));
    expect(effect?.api.maximize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close Effect" }));
    expect(effect?.api.close).toHaveBeenCalledOnce();
  });

  it("shows a close control even for a single-Panel tab", () => {
    const dock = strictModeApi();
    dockHarness.api = dock.api;
    dockHarness.headerApi = {
      id: "preview",
      title: "Preview",
      group: { panels: [{ id: "preview" }] },
    };

    render(<DockWorkspace contracts={contracts} />);

    const preview = dock.panels.get("preview");
    expect(screen.getByTitle("Move Preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Preview" }));
    expect(preview?.api.close).toHaveBeenCalledOnce();
  });

  it("builds a localized tab context menu with working close actions", () => {
    const dock = strictModeApi();
    dockHarness.api = dock.api;

    render(<DockWorkspace contracts={contracts} />);

    const props = dockHarness.captures[
      dockHarness.captures.length - 1
    ] as unknown as {
      getTabContextMenuItems: (params: {
        panel: { id: string };
        group: { panels: { id: string }[] };
      }) => { label: string; action: () => void }[];
    };

    // Multi-Panel group: Close / Close Others / Close All, in English here.
    const multi = props.getTabContextMenuItems({
      panel: { id: "media" },
      group: { panels: [{ id: "media" }, { id: "preview" }] },
    });
    expect(multi.map((item) => item.label)).toEqual([
      "Close",
      "Close Others",
      "Close All",
    ]);

    const media = dock.panels.get("media");
    multi[0]!.action();
    expect(media?.api.close).toHaveBeenCalledOnce();

    const preview = dock.panels.get("preview");
    multi[1]!.action();
    expect(preview?.api.close).toHaveBeenCalledOnce();

    multi[2]!.action();
    expect(dock.panels.size).toBe(0);

    // Single-Panel group: no Close Others.
    const solo = props.getTabContextMenuItems({
      panel: { id: "timeline" },
      group: { panels: [{ id: "timeline" }] },
    });
    expect(solo.map((item) => item.label)).toEqual(["Close", "Close All"]);

    // Unknown panels get no menu at all.
    expect(
      props.getTabContextMenuItems({
        panel: { id: "not-a-panel" },
        group: { panels: [{ id: "not-a-panel" }] },
      }),
    ).toEqual([]);
  });

  it("widens drop targets and sizes the overlay to the resulting split", () => {
    const dock = strictModeApi();
    dockHarness.api = dock.api;

    render(<DockWorkspace contracts={contracts} />);

    const props = dockHarness.captures[
      dockHarness.captures.length - 1
    ] as unknown as {
      dropOverlayModel: (params: { location: string }) => unknown;
      dndEdges: unknown;
    };

    expect(props.dropOverlayModel({ location: "content" })).toEqual({
      activationSize: { value: 30, type: "percentage" },
      size: { value: 50, type: "percentage" },
    });
    expect(props.dropOverlayModel({ location: "tab" })).toBeUndefined();
    expect(
      props.dropOverlayModel({ location: "header_space" }),
    ).toBeUndefined();
    // Root edge bands stay off — they capture-phase-hijack tab-strip drops.
    expect(props.dndEdges).toBe(false);
  });

  it("renders Open Panel and Reset Workspace recovery for an empty tree", async () => {
    const dock = strictModeApi();
    dockHarness.api = dock.api;
    dockHarness.renderWatermark = true;

    render(<DockWorkspace contracts={contracts} />);

    expect(screen.getByRole("region", { name: "Empty workspace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open Panel/ }));
    fireEvent.click(await screen.findByText("Role Mixer"));
    expect(dock.addPanel.mock.calls.some(([options]) =>
      (options as { id?: string }).id === "role-mixer"
    )).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reset Workspace" }));
    expect(dock.fromJSON).toHaveBeenCalledOnce();
    expect(dock.panels.size).toBe(6);
    expect(dock.panels.has("role-mixer")).toBe(false);
  });
});
