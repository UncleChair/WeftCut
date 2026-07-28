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
  themeAbyss,
  type DockviewMessages,
  type DockviewReadyEvent,
  type DockviewTheme,
  type DroptargetOverlayModel,
  type DropOverlayModelParams,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import { TextAlignStartIcon } from "lucide-react";
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
        tracks={summary?.tracks ?? []}
        importing={contracts.importingMediaIds}
        proxyState={contracts.proxyState}
        previewDecodable={contracts.previewDecodableMediaIds}
        fpsNum={summary?.composition.fps_num ?? 30}
        fpsDen={summary?.composition.fps_den ?? 1}
        onCancelImport={async (id) => {
          await importCancel(id).catch(() => false);
        }}
        onMutated={contracts.onMutated}
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

/** Remove the popover row of a just-closed Panel: the dropdown isn't rebuilt
 *  while it's open, and a stale row would point at a dead Panel. */
function removeOverflowRow(target: EventTarget | null): void {
  if (target instanceof HTMLElement) target.closest(".dv-tab")?.remove();
}

/** Behavior layer over Dockview's built-in overflow popover: clicks open the
 *  list anchored under the chevron (not at the mouse point), and once open
 *  Arrow/Home/End move a highlight and Enter activates it (Esc already
 *  closes via Dockview). */
function useTabsOverflowA11y(
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const KB_FOCUS_CLASS = "weft-overflow-row--kb-focus";

    /* Dockview opens the popover at the mouse point, so its position drifts
     * with the click. Swallow trusted chevron clicks in the capture phase and
     * re-dispatch a synthetic click carrying the chevron's own geometry —
     * the popover then always opens anchored directly under the button.
     * Synthetic events report isTrusted=false and pass straight through, but
     * still record the chevron so the right-alignment below knows which
     * button opened the list (the keyboard shortcut path is synthetic too). */
    let lastChevronRoot: HTMLElement | null = null;
    const onClickCapture = (event: MouseEvent) => {
      const target = event.target;
      // Element, not HTMLElement: the chevron icon is an SVG, so clicks that
      // land on it have an SVGElement target — intercept at the parent root
      // regardless of which child the click actually hit.
      if (!(target instanceof Element)) return;
      const root = target.closest<HTMLElement>(
        ".dv-tabs-overflow-dropdown-root",
      );
      if (!root || !container.contains(root)) return;
      lastChevronRoot = root;
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = root.getBoundingClientRect();
      root.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom + 2,
        }),
      );
    };

    /* Right-align the popover under its chevron (the VS Code overflow-menu
     * geometry): panel's right edge flush with the button's right edge.
     * Dockview positions the wrapper from click coordinates and then nudges
     * it into view on a rAF, so alignment runs both synchronously and on the
     * following frame to have the final say. */
    const alignPopover = () => {
      const root = lastChevronRoot;
      const popover = container.querySelector<HTMLElement>(
        ".dv-tabs-overflow-container",
      );
      const wrapper = popover?.parentElement ?? null;
      const anchor = wrapper?.parentElement ?? null;
      if (!root || !popover || !wrapper || !anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const width = popover.getBoundingClientRect().width;
      const clientLeft = root.getBoundingClientRect().right - width;
      wrapper.style.left = `${Math.max(0, clientLeft - anchorRect.left)}px`;
    };
    const popoverObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.firstElementChild?.classList.contains(
              "dv-tabs-overflow-container",
            )
          ) {
            alignPopover();
            requestAnimationFrame(alignPopover);
            return;
          }
        }
      }
    });
    popoverObserver.observe(container, { childList: true, subtree: true });

    const onKeyDown = (event: KeyboardEvent) => {
      const popover = container.querySelector(".dv-tabs-overflow-container");
      if (!popover) return;
      const rows = Array.from(popover.querySelectorAll<HTMLElement>(".dv-tab"));
      if (rows.length === 0) return;
      const current = rows.findIndex((row) =>
        row.classList.contains(KB_FOCUS_CLASS),
      );
      const highlight = (index: number) => {
        rows.forEach((row, i) =>
          row.classList.toggle(KB_FOCUS_CLASS, i === index),
        );
        // Optional call: jsdom (tests) doesn't implement scrollIntoView.
        rows[index]?.scrollIntoView?.({ block: "nearest" });
      };
      switch (event.key) {
        case "ArrowDown":
          highlight(current < 0 ? 0 : (current + 1) % rows.length);
          break;
        case "ArrowUp":
          highlight(
            current < 0
              ? rows.length - 1
              : (current - 1 + rows.length) % rows.length,
          );
          break;
        case "Home":
          highlight(0);
          break;
        case "End":
          highlight(rows.length - 1);
          break;
        case "Enter":
          // No highlight yet: leave Enter to Dockview (it closes the popover).
          if (current < 0) return;
          rows[current]?.click();
          break;
        default:
          return;
      }
      // Capture-phase listener: swallow the key before both Dockview's
      // popover (which dismisses on Enter) and the tab strip's roving focus.
      event.preventDefault();
      event.stopPropagation();
    };

    container.addEventListener("click", onClickCapture, { capture: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      popoverObserver.disconnect();
      container.removeEventListener("click", onClickCapture, { capture: true });
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [containerRef]);
}

export function WeftCutDockTab({
  api,
  tabLocation,
}: IDockviewPanelHeaderProps<DockPanelParams>) {
  const { t } = useTranslation();
  const kind = isPanelKind(api.id) ? api.id : null;
  const title = kind ? t(PANEL_REGISTRY[kind].titleKey) : (api.title ?? api.id);
  const chrome = useWorkspaceChrome();

  /* Overflow-dropdown rows are menu items, not drag sources: no grab cursor,
   * no maximize-on-double-click. Click activation stays with Dockview's row
   * wrapper. Closing a Panel from the list (middle-click) also removes the
   * row — the popover isn't rebuilt while open, and a stale row would point
   * at a dead Panel. */
  if (tabLocation === "headerOverflow") {
    return (
      <div
        className="weft-dock-tab weft-dock-tab--overflow"
        onAuxClick={(event) => {
          if (!kind || event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          removeOverflowRow(event.currentTarget);
          chrome.closePanel(kind);
        }}
      >
        <span className="weft-dock-tab-label">{title}</span>
      </div>
    );
  }

  return (
    <div
      className="weft-dock-tab"
      data-panel-kind={kind ?? undefined}
      onPointerEnter={() => chrome.setHoveredPanel(kind)}
      onPointerLeave={() => chrome.setHoveredPanel(null)}
      onDoubleClick={(event) => {
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        chrome.toggleMaximize(kind);
      }}
    >
      {/* Selection marker: CSS shows it (and the bottom accent) only on
          `.dv-active-tab` — this renderer isn't re-run on activation
          changes, so the marker lives in the DOM of every tab. */}
      <span className="weft-dock-tab-label">{title}</span>
      <TextAlignStartIcon size={12} className="weft-dock-tab-active-icon" aria-hidden="true" />
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

/* Spaced theme: `gap` is layout-level (the shell sizes groups so a real gap
 * sits between them), letting the sunken workspace background show through
 * and separate Panels. `hideBorders` removes the grid's separator borders;
 * it doesn't reach the v7 shell splitviews, so workspace.css also sets
 * `--dv-separator-border: transparent` on `.dv-shell` (the same switch
 * Dockview's own *Spaced themes use). Based on Abyss to keep its base
 * `--dv-*` variable defaults; the className stays Abyss's so those base
 * styles keep applying, while the app's own overrides live on
 * `.weft-dockview` (the `className` prop). */
const WEFT_DOCK_THEME: DockviewTheme = { ...themeAbyss, name: "weft", gap: 6 };

/* Drop-target geometry, tuned so the highlight always equals the layout the
 * drop will produce (a 50/50 split or a full-area tab merge) and targets are
 * large enough to hit: a group's outer third splits, its middle merges, and
 * the outermost groups' edges double as the workspace edges. Dockview's
 * default was a 20% activation zone, which made edge drops hard to hit.
 *
 * The root-level edge band (`dndEdges`) stays off: it listens on the capture
 * phase, so any band wider than the default 10px hijacks drops aimed at the
 * 28px tab strips that live inside it — the exact "drop did not land where I
 * aimed" failure. Generous per-group zones cover the same edges predictably. */
const GROUP_CONTENT_DROP_OVERLAY: DroptargetOverlayModel = {
  activationSize: { value: 30, type: "percentage" },
  size: { value: 50, type: "percentage" },
};

function dropOverlayModel({
  location,
}: DropOverlayModelParams): DroptargetOverlayModel | undefined {
  // Tab-strip and header drops keep the default whole-strip merge highlight.
  return location === "content" ? GROUP_CONTENT_DROP_OVERLAY : undefined;
}

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
  const sectionRef = useRef<HTMLElement | null>(null);
  useTabsOverflowA11y(sectionRef);
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
          ref={sectionRef}
          className="dock-workspace"
          aria-label={t("dock_workspace.editing_label")}
        >
          <DockviewReact
            className="weft-dockview"
            theme={WEFT_DOCK_THEME}
            hideBorders
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
            dropOverlayModel={dropOverlayModel}
            dndEdges={false}
          />
        </section>
      </WorkspaceChromeContext.Provider>
    </ContractsContext.Provider>
  );
}
