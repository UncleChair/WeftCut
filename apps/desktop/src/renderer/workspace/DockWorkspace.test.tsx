// @vitest-environment jsdom

import { StrictMode, type ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DockviewApi } from "dockview-react";

const dockHarness = vi.hoisted(() => ({
  api: null as unknown,
  captures: [] as Record<string, unknown>[],
  readyCalls: 0,
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
      return <div data-testid="dockview" />;
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
    { id: string; api: { setActive(): void; setSize(): void } }
  >();
  const addPanel = vi.fn((options: Record<string, unknown>) => {
    const panel = {
      id: String(options.id),
      api: { setActive: vi.fn(), setSize: vi.fn() },
    };
    panels.set(panel.id, panel);
    return panel;
  });
  const onWillShowOverlay = vi.fn(() => ({ dispose: vi.fn() }));
  const api = {
    width: 1_000,
    height: 800,
    get totalPanels() {
      return panels.size;
    },
    getPanel: (id: string) => panels.get(id),
    addPanel,
    onWillShowOverlay,
  } as unknown as DockviewApi;
  return { api, panels, addPanel, onWillShowOverlay };
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
    expect(dock.onWillShowOverlay).toHaveBeenCalledOnce();

    const props = dockHarness.captures.at(-1) as ComponentProps<
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
});
