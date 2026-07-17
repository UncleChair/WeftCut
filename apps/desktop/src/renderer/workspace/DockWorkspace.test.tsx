// @vitest-environment jsdom

import { StrictMode, type ComponentProps, type ComponentType } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DockviewApi } from "dockview-react";

const dockHarness = vi.hoisted(() => ({
  api: null as unknown,
  captures: [] as Record<string, unknown>[],
  readyCalls: 0,
  renderWatermark: false,
  headerApi: null as unknown,
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
      return (
        <div data-testid="dockview">
          {dockHarness.renderWatermark && Watermark ? <Watermark /> : null}
          {dockHarness.headerApi && Tab ? (
            <Tab api={dockHarness.headerApi} />
          ) : null}
        </div>
      );
    },
  };
});

vi.mock("../ipc", () => ({ importCancel: vi.fn() }));
vi.mock("../timeline/Timeline", () => ({ Timeline: () => null }));
vi.mock("../app/PreviewSection", () => ({ PreviewSection: () => null }));
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
import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
} from "./dockWorkspaceAdapter";

afterEach(() => cleanup());

function strictModeApi() {
  const panels = new Map<
    string,
    {
      id: string;
      group: { panels: unknown[]; api: { isMaximized(): boolean } };
      api: {
        id: string;
        title: string;
        group: { panels: unknown[] };
        setActive: ReturnType<typeof vi.fn>;
        setSize: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        maximize: ReturnType<typeof vi.fn>;
      };
    }
  >();
  const groups: { panels: unknown[] }[] = [];
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
    onDidLayoutChange: event,
    onDidActivePanelChange: event,
    onDidMaximizedGroupChange: event,
    hasMaximizedGroup: vi.fn(() => false),
    exitMaximizedGroup: vi.fn(),
    clear: vi.fn(() => {
      panels.clear();
      groups.splice(0);
    }),
  } as unknown as DockviewApi;
  return { api, panels, addPanel, onWillShowOverlay, overlayDisposers };
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
});

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
    };
    expect(Object.keys(props.components)).toEqual([DOCK_COMPONENT_ID]);
    expect(Object.keys(props.tabComponents)).toEqual([DOCK_TAB_COMPONENT_ID]);
    expect(props.disableFloatingGroups).toBe(true);
    expect(props.dndStrategy).toBe("html5");
  });

  it("shows direct close only for multi-Panel tabs and toggles maximize on chrome", () => {
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

  it("keeps single-Panel chrome to the drag handle without a close control", () => {
    const dock = strictModeApi();
    dockHarness.api = dock.api;
    dockHarness.headerApi = {
      id: "preview",
      title: "Preview",
      group: { panels: [{ id: "preview" }] },
    };

    render(<DockWorkspace contracts={contracts} />);

    expect(screen.getByTitle("Move Preview")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Close Preview" }),
    ).toBeNull();
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
    expect(
      dock.api.clear as unknown as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledOnce();
  });
});
