// Right panel — AB-roll context above, tool workspaces below.
// `docs/data-model.md` R.6.
//
// NearbyPanel owns the A/B-roll-specific context and collapses itself outside
// that mode (or when the window is empty). Properties, captions, and the role
// mixer share the remaining height as persistent tab panels.

import { Tabs } from "@base-ui/react/tabs";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLinesIcon,
  CaptionsIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { type GroupSummary, type TrackSummary } from "../ipc";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import { AttributePanel } from "./AttributePanel";
import { CaptionPanel } from "./CaptionPanel";
import { EffectPanel } from "./EffectPanel";
import { NearbyPanel } from "./NearbyPanel";
import { RoleMixerPanel } from "./RoleMixerPanel";

type RightPanelTab = "properties" | "captions" | "audio";

export interface RightPanelProps {
  tracks: TrackSummary[];
  groups: GroupSummary[];
  selectedLayerId: string | null;
  onSelect: (id: string | null) => void;
  onMutated: () => Promise<void>;
  fpsNum: number;
  fpsDen: number;
  /// Optional inline-reveal hook. When provided, clicking a peek item
  /// dispatches the track id so the Timeline can temporarily inject that row
  /// into its rendered list.
  onRevealTrack?: (trackId: string, layerId: string) => void;
}

export function RightPanel({
  tracks,
  groups,
  selectedLayerId,
  onSelect,
  onMutated,
  fpsNum,
  fpsDen,
  onRevealTrack,
}: RightPanelProps) {
  const { t } = useTranslation();
  // Panel-rate playhead subscription (tier 3, playheadStore.ts): inspector
  // value readouts follow playback at ~10 Hz instead of re-rendering per frame.
  const currentTimeUs = usePlayheadTimeUsThrottled();
  const [activeTab, setActiveTab] = useState<RightPanelTab>("properties");

  // Group editing left the legacy inspector before this extraction. Keep the
  // prop until Dock Workspace replaces this compatibility composition.
  void groups;

  return (
    <aside className="right-panel">
      <NearbyPanel
        tracks={tracks}
        selectedLayerId={selectedLayerId}
        fpsNum={fpsNum}
        fpsDen={fpsDen}
        onPick={(layerId, trackId) => {
          onSelect(layerId);
          setActiveTab("properties");
          onRevealTrack?.(trackId, layerId);
        }}
      />
      <Tabs.Root
        className="right-panel-tabs"
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as RightPanelTab)}
      >
        <Tabs.List
          className="right-panel-tab-list"
          aria-label={t("right_panel.tablist_label")}
          activateOnFocus
        >
          <RightPanelTabButton
            value="properties"
            label={t("right_panel.properties")}
            icon={<SlidersHorizontalIcon size={16} />}
            active={activeTab === "properties"}
          />
          <RightPanelTabButton
            value="captions"
            label={t("right_panel.captions")}
            icon={<CaptionsIcon size={16} />}
            active={activeTab === "captions"}
          />
          <RightPanelTabButton
            value="audio"
            label={t("right_panel.audio")}
            icon={<AudioLinesIcon size={16} />}
            active={activeTab === "audio"}
          />
        </Tabs.List>

        <Tabs.Panel
          className="right-panel-tab-panel right-panel-tab-panel--inspector"
          value="properties"
          keepMounted
        >
          <div className="right-panel-property-stack">
            <AttributePanel
              tracks={tracks}
              selectedLayerId={selectedLayerId}
              onMutated={onMutated}
              fpsNum={fpsNum}
              fpsDen={fpsDen}
              currentTimeUs={currentTimeUs}
            />
            <EffectPanel
              tracks={tracks}
              selectedLayerId={selectedLayerId}
              currentTimeUs={currentTimeUs}
              onMutated={onMutated}
            />
          </div>
        </Tabs.Panel>

        <Tabs.Panel
          className="right-panel-tab-panel right-panel-captions"
          value="captions"
          keepMounted
        >
          <CaptionPanel onMutated={onMutated} />
        </Tabs.Panel>

        <Tabs.Panel
          className="right-panel-tab-panel right-panel-mixer"
          value="audio"
          keepMounted
        >
          <RoleMixerPanel onMutated={onMutated} />
        </Tabs.Panel>
      </Tabs.Root>
    </aside>
  );
}

function RightPanelTabButton({
  value,
  label,
  icon,
  active,
}: {
  value: RightPanelTab;
  label: string;
  icon: ReactNode;
  active: boolean;
}) {
  return (
    <Tabs.Tab
      value={value}
      className={`right-panel-tab ${active ? "is-active" : ""}`}
      aria-label={label}
      title={label}
    >
      <span className="right-panel-tab-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="right-panel-tab-label" aria-hidden="true">
        {label}
      </span>
    </Tabs.Tab>
  );
}
