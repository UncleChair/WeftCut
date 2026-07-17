import {
  createContext,
  useCallback,
  useContext,
  useRef,
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
import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
  DockWorkspaceAdapter,
} from "./dockWorkspaceAdapter";
import {
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

function useContracts(): DockPanelContracts {
  const contracts = useContext(ContractsContext);
  if (!contracts) throw new Error("Dock Panel rendered outside DockWorkspace");
  return contracts;
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
  return (
    <PreviewSection
      previewRef={contracts.previewRef}
      summary={contracts.summary}
      paused={contracts.paused}
      onPausedChange={contracts.onPausedChange}
      onSeek={contracts.onSeek}
      onTogglePlay={contracts.onTogglePlay}
      previewDecodableOf={contracts.previewDecodableOf}
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
  params,
}: IDockviewPanelProps<DockPanelParams>) {
  if (!isPanelKind(params.kind)) return null;
  const Component = PANEL_COMPONENTS[params.kind];
  return (
    <div className="weft-dock-panel" data-panel-kind={params.kind}>
      <Component />
    </div>
  );
}

export function WeftCutDockTab({
  api,
}: IDockviewPanelHeaderProps<DockPanelParams>) {
  const kind = isPanelKind(api.id) ? api.id : null;
  const title = kind ? PANEL_REGISTRY[kind].title : (api.title ?? api.id);
  return (
    <div className="weft-dock-tab" title={`Move ${title}`}>
      <span className="weft-dock-six-dot" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="weft-dock-tab-label">{title}</span>
    </div>
  );
}

const DOCK_COMPONENTS = { [DOCK_COMPONENT_ID]: WeftCutPanelRenderer };
const DOCK_TAB_COMPONENTS = { [DOCK_TAB_COMPONENT_ID]: WeftCutDockTab };

export function DockWorkspace({ contracts }: { contracts: DockPanelContracts }) {
  const adapterRef = useRef<DockWorkspaceAdapter | null>(null);

  const onReady = useCallback(({ api }: DockviewReadyEvent) => {
    let adapter = adapterRef.current;
    if (!adapter?.belongsTo(api)) {
      adapter?.dispose();
      adapter = new DockWorkspaceAdapter(api);
      adapterRef.current = adapter;
    }
    adapter.initializeEditingLayout();
  }, []);

  return (
    <ContractsContext.Provider value={contracts}>
      <section className="dock-workspace" aria-label="Editing workspace">
        <DockviewReact
          className="weft-dockview"
          components={DOCK_COMPONENTS}
          tabComponents={DOCK_TAB_COMPONENTS}
          onReady={onReady}
          disableFloatingGroups
          dndStrategy="html5"
          keyboardNavigation={false}
          noPanelsOverlay="watermark"
          announcements={false}
        />
      </section>
    </ContractsContext.Provider>
  );
}
