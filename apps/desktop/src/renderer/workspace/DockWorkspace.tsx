import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { Timeline } from "../timeline/Timeline";
import { PreviewSection } from "../app/PreviewSection";
import { MediaDropZone, MediaPool } from "../panels/MediaPool";
import { AttributePanel } from "../panels/AttributePanel";
import { CaptionPanel } from "../panels/CaptionPanel";
import { EffectPanel } from "../panels/EffectPanel";
import { NearbyPanel } from "../panels/NearbyPanel";
import { RoleMixerPanel } from "../panels/RoleMixerPanel";
import {
  importCancel,
  type KeybindingsMap,
  type ProjectSummary,
} from "../ipc";
import { type ProxyState } from "../panels/mediaReadiness";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import { Menu, MenuItem } from "../menu/Menu";
import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
  DockWorkspaceAdapter,
  type DockWorkspaceController,
} from "./dockWorkspaceAdapter";
import {
  PANEL_KINDS,
  PANEL_REGISTRY,
  isPanelKind,
  type PanelKind,
} from "./panelRegistry";

export interface DockPanelContracts {
  summary: ProjectSummary | null;
  previewRef: RefObject<PreviewSurfaceHandle | null>;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onSeek: (timeUs: number) => void;
  onTogglePlay: () => void;
  previewDecodableOf: (mediaId: string) => boolean;
  revealedTrackId: string | null;
  keybindings: KeybindingsMap;
  bladeMode: boolean;
  importingMediaIds: ReadonlySet<string>;
  proxyState: ReadonlyMap<string, ProxyState>;
  previewDecodableMediaIds: ReadonlySet<string>;
  onExitBlade: () => void;
  onMutated: () => Promise<void>;
  selectedLayerId: string | null;
  onSelectLayer: (layerId: string | null) => void;
  onRevealTrack: (trackId: string, layerId: string) => void;
}

interface DockPanelParams extends Record<string, unknown> {
  kind: PanelKind;
}

const ContractsContext = createContext<DockPanelContracts | null>(null);

export interface DockPanelRuntimeContract {
  kind: PanelKind;
  isVisible: boolean;
}

const DockPanelRuntimeContext = createContext<DockPanelRuntimeContract | null>(
  null,
);

interface WorkspaceChromeCommands {
  closePanel(kind: PanelKind): void;
  setHoveredPanel(kind: PanelKind | null): void;
  toggleMaximize(kind?: PanelKind): void;
  openPanel(kind: PanelKind): void;
  resetWorkspace(): void;
}

const WorkspaceChromeContext = createContext<WorkspaceChromeCommands | null>(
  null,
);

function useContracts(): DockPanelContracts {
  const contracts = useContext(ContractsContext);
  if (!contracts) throw new Error("Dock Panel rendered outside DockWorkspace");
  return contracts;
}

/** Semantic Panel lifecycle state backed only by Dockview's public API. */
export function useDockPanelRuntime(): DockPanelRuntimeContract {
  const runtime = useContext(DockPanelRuntimeContext);
  if (!runtime) throw new Error("Panel rendered outside its Dock runtime");
  return runtime;
}

function useDockviewPanelVisibility(
  api: IDockviewPanelProps<DockPanelParams>["api"],
): boolean {
  return useSyncExternalStore(
    useCallback(
      (onStoreChange) => {
        const disposable = api.onDidVisibilityChange(onStoreChange);
        return () => disposable.dispose();
      },
      [api],
    ),
    () => api.isVisible,
    () => true,
  );
}

function useWorkspaceChrome(): WorkspaceChromeCommands {
  const chrome = useContext(WorkspaceChromeContext);
  if (!chrome) throw new Error("Dock chrome rendered outside DockWorkspace");
  return chrome;
}

function MediaDockPanel() {
  const contracts = useContracts();
  const summary = contracts.summary;
  return (
    <MediaDropZone>
      <MediaPool
        media={summary?.media ?? []}
        importing={contracts.importingMediaIds}
        proxyState={contracts.proxyState}
        previewDecodable={contracts.previewDecodableMediaIds}
        fpsNum={summary?.composition.fps_num ?? 30}
        fpsDen={summary?.composition.fps_den ?? 1}
        onCancelImport={async (id) => {
          await importCancel(id).catch(() => false);
        }}
      />
    </MediaDropZone>
  );
}

function PreviewDockPanel() {
  const contracts = useContracts();
  const runtime = useDockPanelRuntime();
  return (
    <PreviewSection
      previewRef={contracts.previewRef}
      summary={contracts.summary}
      paused={contracts.paused}
      onPausedChange={contracts.onPausedChange}
      onSeek={contracts.onSeek}
      onTogglePlay={contracts.onTogglePlay}
      previewDecodableOf={contracts.previewDecodableOf}
      visible={runtime.isVisible}
    />
  );
}

function TimelineDockPanel() {
  const contracts = useContracts();
  const summary = contracts.summary;
  return (
    <section className="timeline">
      <Timeline
        tracks={summary?.tracks ?? []}
        groups={summary?.groups ?? []}
        durationUs={summary?.duration_us ?? 0}
        revealedTrackId={contracts.revealedTrackId}
        keybindings={contracts.keybindings}
        fpsNum={summary?.composition.fps_num ?? 30}
        fpsDen={summary?.composition.fps_den ?? 1}
        bladeMode={contracts.bladeMode}
        media={summary?.media ?? []}
        importing={contracts.importingMediaIds}
        proxyState={contracts.proxyState}
        previewDecodable={contracts.previewDecodableMediaIds}
        onExitBlade={contracts.onExitBlade}
        onSeek={contracts.onSeek}
        onMutated={contracts.onMutated}
      />
    </section>
  );
}

function AttributeDockPanel() {
  const contracts = useContracts();
  const currentTimeUs = usePlayheadTimeUsThrottled();
  const summary = contracts.summary;
  return (
    <div className="weft-dock-panel-scroll">
      <AttributePanel
        tracks={summary?.tracks ?? []}
        selectedLayerId={contracts.selectedLayerId}
        onMutated={contracts.onMutated}
        fpsNum={summary?.composition.fps_num ?? 30}
        fpsDen={summary?.composition.fps_den ?? 1}
        currentTimeUs={currentTimeUs}
      />
    </div>
  );
}

function EffectDockPanel() {
  const contracts = useContracts();
  const currentTimeUs = usePlayheadTimeUsThrottled();
  return (
    <div className="weft-dock-panel-scroll">
      <EffectPanel
        tracks={contracts.summary?.tracks ?? []}
        selectedLayerId={contracts.selectedLayerId}
        currentTimeUs={currentTimeUs}
        onMutated={contracts.onMutated}
      />
    </div>
  );
}

function CaptionDockPanel() {
  const contracts = useContracts();
  return (
    <div className="weft-dock-panel-scroll">
      <CaptionPanel onMutated={contracts.onMutated} />
    </div>
  );
}

function RoleMixerDockPanel() {
  const contracts = useContracts();
  return (
    <div className="weft-dock-panel-scroll">
      <RoleMixerPanel onMutated={contracts.onMutated} />
    </div>
  );
}

function NearbyDockPanel() {
  const contracts = useContracts();
  const summary = contracts.summary;
  return (
    <div className="weft-dock-panel-scroll">
      <NearbyPanel
        tracks={summary?.tracks ?? []}
        selectedLayerId={contracts.selectedLayerId}
        fpsNum={summary?.composition.fps_num ?? 30}
        fpsDen={summary?.composition.fps_den ?? 1}
        onPick={(layerId, trackId) => {
          contracts.onSelectLayer(layerId);
          contracts.onRevealTrack(trackId, layerId);
        }}
      />
    </div>
  );
}

const PANEL_COMPONENTS: Readonly<Record<PanelKind, () => ReactElement>> = {
  media: MediaDockPanel,
  preview: PreviewDockPanel,
  timeline: TimelineDockPanel,
  attribute: AttributeDockPanel,
  caption: CaptionDockPanel,
  "role-mixer": RoleMixerDockPanel,
  effect: EffectDockPanel,
  nearby: NearbyDockPanel,
};

export function WeftCutPanelRenderer({
  api,
  params,
}: IDockviewPanelProps<DockPanelParams>) {
  if (!isPanelKind(params.kind)) return null;
  const Component = PANEL_COMPONENTS[params.kind];
  const chrome = useWorkspaceChrome();
  const isVisible = useDockviewPanelVisibility(api);
  const runtime = useMemo<DockPanelRuntimeContract>(
    () => ({ kind: params.kind, isVisible }),
    [isVisible, params.kind],
  );
  return (
    <DockPanelRuntimeContext.Provider value={runtime}>
      <div
        className="weft-dock-panel"
        data-panel-kind={params.kind}
        data-panel-visible={isVisible ? "true" : "false"}
        onPointerEnter={() => chrome.setHoveredPanel(params.kind)}
        onPointerLeave={() => chrome.setHoveredPanel(null)}
      >
        <Component />
      </div>
    </DockPanelRuntimeContext.Provider>
  );
}

export function WeftCutDockTab({
  api,
}: IDockviewPanelHeaderProps<DockPanelParams>) {
  const kind = isPanelKind(api.id) ? api.id : null;
  const title = kind ? PANEL_REGISTRY[kind].title : (api.title ?? api.id);
  const chrome = useWorkspaceChrome();
  const multiple = api.group.panels.length > 1;
  return (
    <div
      className="weft-dock-tab"
      title={`Move ${title}`}
      onPointerEnter={() => chrome.setHoveredPanel(kind)}
      onPointerLeave={() => chrome.setHoveredPanel(null)}
      onDoubleClick={(event) => {
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        chrome.toggleMaximize(kind);
      }}
    >
      <span className="weft-dock-six-dot" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="weft-dock-tab-label">{title}</span>
      {kind && multiple ? (
        <button
          type="button"
          className="weft-dock-tab-close"
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
          draggable={false}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onDragStart={(event) => event.preventDefault()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            chrome.closePanel(kind);
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export function EmptyWorkspaceRecovery() {
  const chrome = useWorkspaceChrome();
  return (
    <div className="weft-dock-empty" role="region" aria-label="Empty workspace">
      <p>All Panels are closed.</p>
      <div className="weft-dock-empty-actions">
        <Menu label="Open Panel">
          {PANEL_KINDS.map((kind) => (
            <MenuItem
              key={kind}
              label={PANEL_REGISTRY[kind].title}
              onSelect={() => chrome.openPanel(kind)}
            />
          ))}
        </Menu>
        <button type="button" onClick={() => chrome.resetWorkspace()}>
          Reset Workspace
        </button>
      </div>
    </div>
  );
}

const DOCK_COMPONENTS = { [DOCK_COMPONENT_ID]: WeftCutPanelRenderer };
const DOCK_TAB_COMPONENTS = { [DOCK_TAB_COMPONENT_ID]: WeftCutDockTab };

interface DockWorkspaceProps {
  contracts: DockPanelContracts;
  onControllerReady?: (controller: DockWorkspaceController | null) => void;
}

export function DockWorkspace({
  contracts,
  onControllerReady,
}: DockWorkspaceProps) {
  const adapterRef = useRef<DockWorkspaceAdapter | null>(null);

  const chrome = useMemo<WorkspaceChromeCommands>(
    () => ({
      closePanel: (kind) => adapterRef.current?.closePanel(kind),
      setHoveredPanel: (kind) => adapterRef.current?.setHoveredPanel(kind),
      toggleMaximize: (kind) => adapterRef.current?.toggleMaximize(kind),
      openPanel: (kind) => adapterRef.current?.openPanel(kind),
      resetWorkspace: () => adapterRef.current?.resetWorkspace(),
    }),
    [],
  );

  const onReady = useCallback(({ api }: DockviewReadyEvent) => {
    let adapter = adapterRef.current;
    if (!adapter?.belongsTo(api)) {
      adapter?.dispose();
      adapter = new DockWorkspaceAdapter(api);
      adapterRef.current = adapter;
    }
    adapter.initializeEditingLayout();
    onControllerReady?.(adapter);
  }, [onControllerReady]);

  useEffect(
    () => () => {
      adapterRef.current?.dispose();
      adapterRef.current = null;
      onControllerReady?.(null);
    },
    [onControllerReady],
  );

  return (
    <ContractsContext.Provider value={contracts}>
      <WorkspaceChromeContext.Provider value={chrome}>
        <section className="dock-workspace" aria-label="Editing workspace">
          <DockviewReact
            className="weft-dockview"
            components={DOCK_COMPONENTS}
            tabComponents={DOCK_TAB_COMPONENTS}
            watermarkComponent={EmptyWorkspaceRecovery}
            onReady={onReady}
            disableFloatingGroups
            dndStrategy="html5"
            keyboardNavigation={false}
            noPanelsOverlay="watermark"
            announcements={false}
          />
        </section>
      </WorkspaceChromeContext.Provider>
    </ContractsContext.Provider>
  );
}
