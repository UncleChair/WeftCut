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
  type DockviewMessages,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import { GripVerticalIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  updateLayer,
  type KeybindingsMap,
  type ProjectSummary,
} from "../ipc";
import { type ProxyState } from "../panels/mediaReadiness";
import { type PreviewSurfaceHandle } from "../preview/PreviewSurface";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import { jumpToTimeUs } from "../state/navigation";
import { Menu, MenuItem } from "../menu/Menu";
import {
  DockWorkspaceAdapter,
  type DockWorkspaceController,
} from "./dockWorkspaceAdapter";
import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
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
  const runtime = useDockPanelRuntime();
  const summary = contracts.summary;
  return (
    <section className="timeline">
      <Timeline
        tracks={summary?.tracks ?? []}
        groups={summary?.groups ?? []}
        transitions={summary?.transitions ?? []}
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
        visible={runtime.isVisible}
        onExitBlade={contracts.onExitBlade}
        onSeek={contracts.onSeek}
        onMutated={contracts.onMutated}
      />
    </section>
  );
}

function AttributeDockPanel() {
  const contracts = useContracts();
  const runtime = useDockPanelRuntime();
  const currentTimeUs = usePlayheadTimeUsThrottled(100, runtime.isVisible);
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
  const runtime = useDockPanelRuntime();
  const currentTimeUs = usePlayheadTimeUsThrottled(100, runtime.isVisible);
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
      <CaptionPanel
        onMutated={contracts.onMutated}
        selectedLayerId={contracts.selectedLayerId}
        onActivateCue={(layerId, trackId, startUs) => {
          // Cue activation = select the Text Layer, seek to its start, and
          // reveal it in Timeline — synchronizing caption navigation with
          // timeline context (mirrors Nearby's explicit Go To).
          contracts.onSelectLayer(layerId);
          jumpToTimeUs(startUs);
          contracts.onRevealTrack(trackId, layerId);
        }}
      />
    </div>
  );
}

function RoleMixerDockPanel() {
  const contracts = useContracts();
  const runtime = useDockPanelRuntime();
  return (
    <div className="weft-dock-panel-scroll">
      <RoleMixerPanel onMutated={contracts.onMutated} visible={runtime.isVisible} />
    </div>
  );
}

function NearbyDockPanel() {
  const contracts = useContracts();
  const runtime = useDockPanelRuntime();
  const summary = contracts.summary;
  return (
    <div className="weft-dock-panel-scroll">
      <NearbyPanel
        tracks={summary?.tracks ?? []}
        selectedLayerId={contracts.selectedLayerId}
        fpsNum={summary?.composition.fps_num ?? 30}
        fpsDen={summary?.composition.fps_den ?? 1}
        visible={runtime.isVisible}
        onPick={(layerId, trackId) => {
          // Reveal without seeking: the near-playhead window stays put.
          contracts.onSelectLayer(layerId);
          contracts.onRevealTrack(trackId, layerId);
        }}
        onGoTo={(layerId, trackId, startUs) => {
          // Explicit navigation: seek the playhead and scroll into view.
          contracts.onSelectLayer(layerId);
          jumpToTimeUs(startUs);
          contracts.onRevealTrack(trackId, layerId);
        }}
        onRename={async (layerId, nextLabel) => {
          await updateLayer(layerId, { label: nextLabel });
          await contracts.onMutated();
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
  const { t } = useTranslation();
  const kind = isPanelKind(api.id) ? api.id : null;
  const title = kind ? t(PANEL_REGISTRY[kind].titleKey) : (api.title ?? api.id);
  const chrome = useWorkspaceChrome();
  const multiple = api.group.panels.length > 1;
  return (
    <div
      className="weft-dock-tab"
      title={t("dock_workspace.move_panel", { title })}
      onPointerEnter={() => chrome.setHoveredPanel(kind)}
      onPointerLeave={() => chrome.setHoveredPanel(null)}
      onDoubleClick={(event) => {
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        chrome.toggleMaximize(kind);
      }}
    >
      <span className="weft-dock-grip" aria-hidden="true">
        <GripVerticalIcon size={14} />
      </span>
      <span className="weft-dock-tab-label">{title}</span>
      {kind && multiple ? (
        <button
          type="button"
          className="weft-dock-tab-close"
          aria-label={t("dock_workspace.close_panel", { title })}
          title={t("dock_workspace.close_panel", { title })}
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
          <XIcon size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function EmptyWorkspaceRecovery() {
  const chrome = useWorkspaceChrome();
  const { t } = useTranslation();
  return (
    <div
      className="weft-dock-empty"
      role="region"
      aria-label={t("dock_workspace.empty_label")}
    >
      <p>{t("dock_workspace.all_closed")}</p>
      <div className="weft-dock-empty-actions">
        <Menu label={t("dock_workspace.open_panel")}>
          {PANEL_KINDS.map((kind) => (
            <MenuItem
              key={kind}
              label={t(PANEL_REGISTRY[kind].titleKey)}
              onSelect={() => chrome.openPanel(kind)}
            />
          ))}
        </Menu>
        <button type="button" onClick={() => chrome.resetWorkspace()}>
          {t("dock_workspace.reset")}
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
  onResetWorkspace?: () => void;
}

export function DockWorkspace({
  contracts,
  onControllerReady,
  onResetWorkspace,
}: DockWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const adapterRef = useRef<DockWorkspaceAdapter | null>(null);
  const messages = useMemo<Partial<DockviewMessages>>(
    () => ({
      panelOpened: (title) => t("dock_workspace.announce.opened", { title }),
      panelClosed: (title) => t("dock_workspace.announce.closed", { title }),
      groupMaximized: (title) => t("dock_workspace.announce.maximized", { title }),
      groupRestored: (title) => t("dock_workspace.announce.restored", { title }),
      movePickTarget: (source, target, current, total) =>
        t("dock_workspace.announce.pick_target", { source, target, current, total }),
      movePickEdge: (position, target) =>
        t("dock_workspace.announce.pick_edge", {
          position: t(`dock_workspace.position.${position}`),
          target,
        }),
      moveCommitted: (source, target, position) =>
        t("dock_workspace.announce.committed", {
          source,
          target,
          position: t(`dock_workspace.position.${position}`),
        }),
      moveCancelled: () => t("dock_workspace.announce.cancelled"),
      moveNotAllowed: () => t("dock_workspace.announce.not_allowed"),
    }),
    [t],
  );

  const chrome = useMemo<WorkspaceChromeCommands>(
    () => ({
      closePanel: (kind) => adapterRef.current?.closePanel(kind),
      setHoveredPanel: (kind) => adapterRef.current?.setHoveredPanel(kind),
      toggleMaximize: (kind) => adapterRef.current?.toggleMaximize(kind),
      openPanel: (kind) => adapterRef.current?.openPanel(kind),
      resetWorkspace: () => {
        if (onResetWorkspace) onResetWorkspace();
        else adapterRef.current?.resetWorkspace();
      },
    }),
    [onResetWorkspace],
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

  useEffect(() => {
    adapterRef.current?.refreshPanelTitles();
  }, [i18n.resolvedLanguage]);

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
        <section
          className="dock-workspace"
          aria-label={t("dock_workspace.editing_label")}
        >
          <DockviewReact
            className="weft-dockview"
            components={DOCK_COMPONENTS}
            tabComponents={DOCK_TAB_COMPONENTS}
            watermarkComponent={EmptyWorkspaceRecovery}
            onReady={onReady}
            disableFloatingGroups
            dndStrategy="html5"
            keyboardNavigation
            noPanelsOverlay="watermark"
            announcements
            messages={messages}
          />
        </section>
      </WorkspaceChromeContext.Provider>
    </ContractsContext.Provider>
  );
}
