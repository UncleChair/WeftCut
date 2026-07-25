import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  type ApiKeyStatus,
  type DataRootCurrent,
  type DataRootProgress,
  type KeybindingsMap,
  DATA_ROOT_EVENTS,
  dataRootCurrent,
  dataRootDeleteOld,
  dataRootDismissCleanup,
  dataRootOpenFolder,
  dataRootPendingCleanup,
  dataRootPickAndMigrate,
  dataRootRelaunch,
  fitCompositionToLayers,
  getProjectSettings,
  recentsGetReopenOnLaunch,
  recentsSetReopenOnLaunch,
  setComposition,
  settingsClearApiKey,
  settingsSetApiKey,
  settingsTestProvider,
  settingsGetSpeechBackends,
  settingsSetSpeechPreferred,
  settingsSetLocalBackend,
  settingsClearLocalBackend,
  type SpeechBackendInfo,
  type SpeechBackendsView,
  type PreferredEngine,
  updateProjectSettings,
} from "../ipc";
import { listen, type UnlistenFn } from "@/bridge/events";
import { open as openFileDialog } from "@/bridge/dialog";
import { formatTimecode, parseTimecode, wallClockAside } from "../frames";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { AppSlider } from "../components/AppSlider";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import { KeybindingPanel } from "./KeybindingPanel";
import { decodeEngineOptions } from "./decodeEngineOptions";
import { speechEngineOptions } from "./speechEngineOptions";
import {
  useDecodeComponentAvailable,
  useDecodeComponentReason,
} from "./decodeComponentStore";
import {
  setAppSettings,
  useDecodeEngine,
  usePrebakeMotifsEnabled,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "./appSettingsStore";
import { setPreferProxies, useProxyPrefStore } from "../state/proxyPreferenceStore";

const TAIL_SNAP_MIN_PX = 2;
const TAIL_SNAP_MAX_PX = 80;

function clampTailSnapStrength(value: number): number {
  return Math.round(Math.min(TAIL_SNAP_MAX_PX, Math.max(TAIL_SNAP_MIN_PX, value)));
}

type SettingsCategory = "general" | "editing" | "keyboard" | "apikeys";

/// Sidebar order. Every pane stays mounted (toggled via `hidden`) so
/// in-progress input and per-section fetches survive a tab switch.
const CATEGORIES: ReadonlyArray<{ id: SettingsCategory; labelKey: string }> = [
  { id: "general", labelKey: "settings.cat_general" },
  { id: "editing", labelKey: "settings.cat_editing" },
  { id: "keyboard", labelKey: "settings.cat_keyboard" },
  { id: "apikeys", labelKey: "settings.cat_api_keys" },
];

/// Small pill marking a setting whose value travels with the .vproj
/// (per-project) instead of the app — the two scopes look identical in
/// the list otherwise.
function ProjectBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="settings-scope-badge"
      title={t("settings.scope_project_hint")}
    >
      {t("settings.scope_project")}
    </span>
  );
}

interface CompositionState {
  durationUs: number;
  durationPinned: boolean;
  /// Live `max(layer.t_end_us)` — the floor a pinned duration can't sit
  /// below. Pre-validation only; the Rust-side overflow guard is the
  /// source of truth.
  layersMaxEndUs: number;
  fpsNum: number;
  fpsDen: number;
}

interface Props {
  onClose: () => void;
  /// Category selected when the modal mounts. System-status actions use this
  /// to deep-link directly to the relevant recovery controls.
  initialCategory?: SettingsCategory;
  /// Shortcut overrides owned by App.tsx. Threaded through so the
  /// Keyboard section can render the current bindings and the
  /// dispatcher re-resolves the moment the user edits.
  keybindings: KeybindingsMap;
  onKeybindingsChanged: (next: KeybindingsMap) => void;
  /// Live composition state for the Composition section. `null` while
  /// the project summary is still loading.
  composition: CompositionState | null;
  /// Refresh the parent project summary after Pin / Fit actions so the
  /// section's labels reflect the new state immediately.
  onCompositionChanged: () => Promise<void> | void;
}

export function SettingsPanel({
  onClose,
  initialCategory = "general",
  keybindings,
  onKeybindingsChanged,
  composition,
  onCompositionChanged,
}: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [reopenOnLaunch, setReopenOnLaunch] = useState<boolean | null>(null);
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const tabRefs = useRef<
    Partial<Record<SettingsCategory, HTMLButtonElement | null>>
  >({});

  /// Roving-tabindex keyboard nav for the vertical tablist (WAI-ARIA
  /// tabs pattern): arrows move + activate, Home/End jump to the ends.
  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const order = CATEGORIES.map((c) => c.id);
    const idx = order.indexOf(category);
    let next: SettingsCategory | undefined;
    if (e.key === "ArrowDown") next = order[(idx + 1) % order.length];
    else if (e.key === "ArrowUp")
      next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (next) {
      e.preventDefault();
      setCategory(next);
      tabRefs.current[next]?.focus();
    }
  };

  useEffect(() => {
    recentsGetReopenOnLaunch()
      .then(setReopenOnLaunch)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <AppDialog
      title={t("settings.heading")}
      onClose={onClose}
      closeLabel={t("settings.close")}
      panelClassName="settings-panel settings-panel--nav"
    >
      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("settings.heading")}
          onKeyDown={onNavKeyDown}
        >
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              ref={(el) => {
                tabRefs.current[c.id] = el;
              }}
              type="button"
              role="tab"
              id={`settings-tab-${c.id}`}
              aria-selected={category === c.id}
              aria-controls={`settings-panel-${c.id}`}
              tabIndex={category === c.id ? 0 : -1}
              className={
                category === c.id
                  ? "settings-nav-item is-active"
                  : "settings-nav-item"
              }
              onClick={() => setCategory(c.id)}
            >
              {t(c.labelKey)}
            </button>
          ))}
        </div>

        <div className="settings-content">
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}

          <div
            role="tabpanel"
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
            hidden={category !== "general"}
            className="settings-pane"
          >
            <div className="settings-pane-title">{t("settings.cat_general")}</div>
            <section className="settings-section">
              <h3>{t("settings.startup_heading")}</h3>
              <label className="settings-toggle-row">
                <AppSwitch
                  checked={reopenOnLaunch === true}
                  disabled={reopenOnLaunch === null}
                  onCheckedChange={async (next) => {
                    setReopenOnLaunch(next);
                    try {
                      await recentsSetReopenOnLaunch(next);
                    } catch (err) {
                      setError(String(err));
                      setReopenOnLaunch(!next);
                    }
                  }}
                />
                <span>
                  <span className="settings-toggle-label">
                    {t("settings.reopen_on_launch")}
                  </span>
                  <span className="settings-toggle-hint">
                    {t("settings.reopen_on_launch_hint")}
                  </span>
                </span>
              </label>
            </section>

            <section className="settings-section">
              <h3>{t("settings.data_location_heading")}</h3>
              <p className="settings-blurb">
                {t("settings.data_location_blurb")}
              </p>
              <DataLocationSection onError={setError} />
            </section>

            <section className="settings-section">
              <h3>{t("settings.motifs_heading")}</h3>
              <PrebakeSection onError={setError} />
            </section>

            <section className="settings-section">
              <DecodeEngineSection onError={setError} />
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-editing"
            aria-labelledby="settings-tab-editing"
            hidden={category !== "editing"}
            className="settings-pane"
          >
            <div className="settings-pane-title">{t("settings.cat_editing")}</div>
            <section className="settings-section">
              <h3>
                {t("settings.composition_heading")}
                <ProjectBadge />
              </h3>
              <p className="settings-blurb">{t("settings.composition_blurb")}</p>
              <CompositionSection
                composition={composition}
                onChanged={onCompositionChanged}
                onError={setError}
              />
            </section>

            <section className="settings-section">
              <h3>{t("settings.timeline_heading")}</h3>
              <p className="settings-blurb">{t("settings.timeline_blurb")}</p>
              <TimelineSnapSection onError={setError} />
              <AutoDeleteEmptyTracksSection onError={setError} />
              <PreferProxiesToggle onError={setError} />
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-keyboard"
            aria-labelledby="settings-tab-keyboard"
            hidden={category !== "keyboard"}
            className="settings-pane"
          >
            <div className="settings-pane-title">
              {t("settings.cat_keyboard")}
            </div>
            <section className="settings-section">
              <p className="settings-blurb">{t("settings.keybindings_blurb")}</p>
              <KeybindingPanel
                keybindings={keybindings}
                onChanged={onKeybindingsChanged}
                onError={setError}
              />
            </section>
          </div>

          <div
            role="tabpanel"
            id="settings-panel-apikeys"
            aria-labelledby="settings-tab-apikeys"
            hidden={category !== "apikeys"}
            className="settings-pane"
          >
            <div className="settings-pane-title">
              {t("settings.cat_api_keys")}
            </div>
            <SpeechSection onError={setError} />
          </div>
        </div>
      </div>
    </AppDialog>
  );
}

function TimelineSnapSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = useTailSnapEnabled();
  const strengthPx = useTailSnapStrengthPx();
  const [draftStrengthPx, setDraftStrengthPx] = useState(strengthPx);

  useEffect(() => {
    setDraftStrengthPx(strengthPx);
  }, [strengthPx]);

  const commitStrength = async (value: number) => {
    const next = clampTailSnapStrength(value);
    setDraftStrengthPx(next);
    onError("");
    try {
      await setAppSettings({ tail_snap_strength_px: next });
    } catch (e) {
      onError(String(e));
      setDraftStrengthPx(strengthPx);
    }
  };

  return (
    <>
      <label className="settings-toggle-row">
        <AppSwitch
          checked={enabled}
          onCheckedChange={async (next) => {
            onError("");
            try {
              await setAppSettings({ tail_snap_enabled: next });
            } catch (err) {
              onError(String(err));
            }
          }}
        />
        <span>
          <span className="settings-toggle-label">
            {t("settings.tail_snap_enabled")}
          </span>
          <span className="settings-toggle-hint">
            {t("settings.tail_snap_enabled_hint")}
          </span>
        </span>
      </label>
      <div className="settings-slider-row">
        <span className="settings-slider-label">
          {t("settings.tail_snap_strength")}
        </span>
        <AppSlider
          min={TAIL_SNAP_MIN_PX}
          max={TAIL_SNAP_MAX_PX}
          value={draftStrengthPx}
          disabled={!enabled}
          onValueChange={setDraftStrengthPx}
          onValueCommitted={(v) => void commitStrength(v)}
          ariaLabel={t("settings.tail_snap_strength")}
        />
        <AppNumberField value={draftStrengthPx} min={TAIL_SNAP_MIN_PX} max={TAIL_SNAP_MAX_PX}
          disabled={!enabled} align="center" className="settings-input-narrow"
          ariaLabel={t("settings.tail_snap_strength")}
          onValueChange={setDraftStrengthPx} onCommit={(v) => void commitStrength(v)} />
        <span className="settings-slider-unit">px</span>
      </div>
      <p className="settings-toggle-hint">
        {t("settings.tail_snap_strength_hint")}
      </p>
    </>
  );
}

/// Per-project toggle (`Project.settings.auto_delete_empty_tracks`),
/// unlike the app-level sections around it — it travels with the .vproj
/// because the actor's delete mutation reads it. Fetch-on-mount +
/// optimistic flip with rollback, same shape as the reopen-on-launch row.
function AutoDeleteEmptyTracksSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    getProjectSettings()
      .then((s) => setEnabled(s.auto_delete_empty_tracks))
      .catch((e) => onError(String(e)));
  }, [onError]);

  return (
    <label className="settings-toggle-row">
      <AppSwitch
        checked={enabled === true}
        disabled={enabled === null}
        onCheckedChange={async (next) => {
          setEnabled(next);
          onError("");
          try {
            await updateProjectSettings({ auto_delete_empty_tracks: next });
          } catch (err) {
            onError(String(err));
            setEnabled(!next);
          }
        }}
      />
      <span>
        <span className="settings-toggle-label">
          {t("settings.auto_delete_empty_tracks")}
          <ProjectBadge />
        </span>
        <span className="settings-toggle-hint">
          {t("settings.auto_delete_empty_tracks_hint")}
        </span>
      </span>
    </label>
  );
}

/// Per-project toggle (`Project.settings.prefer_proxies`) — same markup as
/// AutoDeleteEmptyTracksSection above, but the value is already hydrated
/// and kept in sync by `proxyPreferenceStore` (PixiPreview reads it live
/// per `ensureClip`), so this reads the store directly instead of
/// fetch-on-mount, and writes through `setPreferProxies` instead of the
/// generic `updateProjectSettings` call.
function PreferProxiesToggle({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const enabled = useProxyPrefStore((s) => s.preferProxies);

  return (
    <label className="settings-toggle-row">
      <AppSwitch
        checked={enabled}
        onCheckedChange={async (next) => {
          onError("");
          try {
            await setPreferProxies(next);
          } catch (err) {
            onError(String(err));
          }
        }}
      />
      <span>
        <span className="settings-toggle-label">
          {t("settings.prefer_proxies")}
          <ProjectBadge />
        </span>
        <span className="settings-toggle-hint">
          {t("settings.prefer_proxies_hint")}
        </span>
      </span>
    </label>
  );
}

function PrebakeSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const enabled = usePrebakeMotifsEnabled();
  return (
    <label className="settings-toggle-row">
      <AppSwitch
        checked={enabled}
        onCheckedChange={async (next) => {
          onError("");
          try {
            await setAppSettings({ prebake_motifs: next });
          } catch (err) {
            onError(String(err));
          }
        }}
      />
      <span>
        <span className="settings-toggle-label">{t("settings.prebake_motifs")}</span>
        <span className="settings-toggle-hint">{t("settings.prebake_motifs_hint")}</span>
      </span>
    </label>
  );
}

/// Migration lifecycle for the "Change…" action. `running` holds the latest
/// progress tick (null until the first arrives — ADOPT never emits one, so the
/// bar stays indeterminate through an instant adopt). `success`/`error` are
/// terminal: success offers the relaunch affordance, error shows the rollback
/// message (the resolver already reverted; `data_root` is unchanged).
type MigrateState =
  | { kind: "idle" }
  | { kind: "running"; progress: DataRootProgress | null }
  | { kind: "success"; mode: "adopt" | "copy"; newPath: string }
  | { kind: "error"; message: string };

/// "Data location" section — shows the effective data root, drives the ticket-03
/// copy/adopt migration (Change…), opens the folder, and — after a relaunch onto
/// a new root — offers to delete the old copy. Exported for the component test.
export function DataLocationSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<DataRootCurrent | null>(null);
  const [migrate, setMigrate] = useState<MigrateState>({ kind: "idle" });
  /// The old copy the user may delete post-relaunch; null while nothing pends.
  const [pendingOld, setPendingOld] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /// The live progress subscription for the in-flight migration only. Held in a
  /// ref so the unmount cleanup can drop it even mid-copy.
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Per-section fetch-on-mount (the general pane stays mounted and toggles via
  // `hidden`, so this effect runs once). Also probes for a pending delete-old
  // marker left by a completed relaunch onto a new root.
  useEffect(() => {
    dataRootCurrent()
      .then(setCurrent)
      .catch((e) => onError(String(e)));
    dataRootPendingCleanup()
      .then((p) => {
        if (p) setPendingOld(p.oldPath);
      })
      .catch((e) => onError(String(e)));
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [onError]);

  const change = async () => {
    onError("");
    setMigrate({ kind: "running", progress: null });
    try {
      // Subscribe to copy progress for the duration of this migration only.
      // Delivered out-of-band on `evt:dataRoot:progress` (see DATA_ROOT_EVENTS);
      // ADOPT emits no copy ticks — just a final `done` — so the bar stays
      // indeterminate until totalFiles is counted (never, for adopt).
      unlistenRef.current = await listen<DataRootProgress>(
        DATA_ROOT_EVENTS.progress,
        (e) => {
          setMigrate((s) =>
            s.kind === "running"
              ? { kind: "running", progress: e.payload }
              : s,
          );
        },
      );
      const result = await dataRootPickAndMigrate();
      if (result.ok) {
        setMigrate({
          kind: "success",
          mode: result.mode,
          newPath: result.newPath,
        });
      } else if ("cancelled" in result) {
        // User dismissed the native picker — silently return to idle.
        setMigrate({ kind: "idle" });
      } else {
        setMigrate({ kind: "error", message: result.error });
      }
    } catch (e) {
      setMigrate({ kind: "error", message: String(e) });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const openFolder = async () => {
    onError("");
    try {
      await dataRootOpenFolder();
    } catch (e) {
      onError(String(e));
    }
  };

  const restart = async () => {
    onError("");
    try {
      await dataRootRelaunch();
    } catch (e) {
      setMigrate({ kind: "error", message: String(e) });
    }
  };

  const deleteOld = async () => {
    setDeleteBusy(true);
    onError("");
    try {
      await dataRootDeleteOld();
      setPendingOld(null);
    } catch (e) {
      onError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  /// Keep the old copy: dismiss the prompt AND clear the marker so it is a
  /// one-time offer (no re-prompt next launch). Resolves every non-destructive
  /// close path (the Keep button, Escape, backdrop, ✕). Non-destructive — the
  /// old folder stays on disk for the user to remove manually.
  const keepOld = () => {
    setPendingOld(null);
    void dataRootDismissCleanup().catch((e) => onError(String(e)));
  };

  const busy = migrate.kind === "running";
  const prog = migrate.kind === "running" ? migrate.progress : null;
  const percentKnown = prog !== null && prog.totalFiles > 0;
  const percent = percentKnown
    ? Math.round((prog.copiedFiles / prog.totalFiles) * 100)
    : 0;

  return (
    <>
      <div className="settings-key-row">
        <div className="settings-data-location">
          <div className="settings-key-header">
            <span className="settings-key-label">
              {t("settings.data_location_current_label")}
            </span>
            {current?.isFallback && (
              <span className="settings-badge settings-badge-off">
                {t("settings.data_location_fallback")}
              </span>
            )}
          </div>

          <p className="settings-data-path">{current ? current.path : "…"}</p>

          <div className="settings-key-input-row">
            <Button size="sm" onClick={() => void change()} disabled={busy}>
              {t("settings.data_location_change")}
            </Button>
            <Button
              size="sm"
              onClick={() => void openFolder()}
              disabled={busy || current === null}
            >
              {t("settings.data_location_open_folder")}
            </Button>
          </div>

          {migrate.kind === "running" && (
            <div className="settings-data-migrate" aria-live="polite">
              <p className="settings-toggle-hint">
                {prog
                  ? t(`settings.data_location_phase_${prog.phase}`)
                  : t("settings.data_location_working")}
                {percentKnown &&
                  ` — ${t("settings.data_location_progress_count", {
                    copied: prog.copiedFiles,
                    total: prog.totalFiles,
                  })}`}
              </p>
              <div
                className="progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(percentKnown ? { "aria-valuenow": percent } : {})}
              >
                <div
                  className="progress-fill"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}

          {migrate.kind === "success" && (
            <div className="settings-data-migrate">
              <p className="settings-test-ok">
                {migrate.mode === "adopt"
                  ? t("settings.data_location_success_adopt", {
                      path: migrate.newPath,
                    })
                  : t("settings.data_location_success_copy", {
                      path: migrate.newPath,
                    })}
              </p>
              <div className="settings-key-input-row">
                <Button size="sm" onClick={() => void restart()}>
                  {t("settings.data_location_restart")}
                </Button>
              </div>
            </div>
          )}

          {migrate.kind === "error" && (
            <p className="settings-test-err" role="alert">
              {t("settings.data_location_error", { message: migrate.message })}
            </p>
          )}
        </div>
      </div>

      {pendingOld !== null && (
        <AppDialog
          title={t("settings.data_location_cleanup_title")}
          onClose={keepOld}
          closeLabel={t("settings.data_location_cleanup_keep")}
          panelClassName="settings-panel"
        >
          <div className="settings-body">
            <div className="settings-card">
              <p className="settings-blurb">
                {t("settings.data_location_cleanup_body", { path: pendingOld })}
              </p>
              <div className="export-actions">
                {/* Non-destructive default: Keep is the primary, auto-focused
                    action and is what the dialog's Escape / backdrop / ✕ close
                    resolve to. Deletion is the clearly-labelled destructive
                    secondary and only ever runs on this explicit click. */}
                <Button
                  size="lg"
                  autoFocus
                  onClick={keepOld}
                  disabled={deleteBusy}
                >
                  {t("settings.data_location_cleanup_keep")}
                </Button>
                <Button
                  variant="destructive"
                  size="lg"
                  onClick={() => void deleteOld()}
                  disabled={deleteBusy}
                >
                  {deleteBusy
                    ? t("settings.data_location_cleanup_deleting")
                    : t("settings.data_location_cleanup_delete")}
                </Button>
              </div>
            </div>
          </div>
        </AppDialog>
      )}
    </>
  );
}

function DecodeEngineSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const engine = useDecodeEngine();
  const componentAvailable = useDecodeComponentAvailable();
  const componentReason = useDecodeComponentReason();
  return (
    <label className="settings-toggle-row">
      <AppSelect
        value={engine}
        onValueChange={async (next) => {
          onError("");
          if (next === "ffmpeg" && !componentAvailable) {
            onError(
              t("settings.decode_engine_unavailable", {
                reason: componentReason ?? "",
              }),
            );
            return;
          }
          try {
            await setAppSettings({
              decode_engine: next as "auto" | "ffmpeg" | "webcodecs",
            });
          } catch (err) {
            onError(String(err));
          }
        }}
        options={decodeEngineOptions(t, componentAvailable)}
      />
      <span>
        <span className="settings-toggle-label">{t("settings.decode_engine")}</span>
        <span className="settings-toggle-hint">
          {componentAvailable
            ? t("settings.decode_engine_hint")
            : t("settings.decode_engine_unavailable", {
                reason: componentReason ?? "",
              })}
        </span>
      </span>
    </label>
  );
}

function CompositionSection({
  composition,
  onChanged,
  onError,
}: {
  composition: CompositionState | null;
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /// Local edit buffer for the timecode input while the user is typing.
  /// `null` means "not editing — display the canonical formatted value".
  const [draft, setDraft] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset draft + local error whenever the upstream composition snapshot
  // changes (e.g., the user committed, or a layer edit elsewhere refit
  // the duration). Compare on the `durationUs` + pin flag to avoid
  // resetting while the user is mid-keystroke against the same value.
  useEffect(() => {
    setDraft(null);
    setLocalError(null);
  }, [composition?.durationUs, composition?.durationPinned]);

  const pinned = composition?.durationPinned ?? false;
  const disabled = composition === null || busy;
  const displayValue =
    composition === null
      ? ""
      : formatTimecode(composition.durationUs, composition.fpsNum, composition.fpsDen);
  const floorDisplay =
    composition === null
      ? ""
      : formatTimecode(composition.layersMaxEndUs, composition.fpsNum, composition.fpsDen);
  // Both readouts here are DURATIONS, so at 23.976/29.97/59.94 their NDF digits
  // under-report real time by ~0.1% and the wall-clock figure says so. Null at
  // integer rates — the two figures would be identical (spec R2-D3).
  const durationWallClock =
    composition === null
      ? null
      : wallClockAside(composition.durationUs, composition.fpsNum, composition.fpsDen);
  const floorWallClock =
    composition === null
      ? null
      : wallClockAside(composition.layersMaxEndUs, composition.fpsNum, composition.fpsDen);

  /// Pure validator — runs on every keystroke so the user sees feedback
  /// while typing rather than only on commit. Returns the localized
  /// error string or null when the draft is valid.
  const validateDraft = (value: string): string | null => {
    if (!composition) return null;
    const parsed = parseTimecode(value, composition.fpsNum, composition.fpsDen);
    if (parsed === null) return t("settings.composition_duration_invalid");
    if (parsed < composition.layersMaxEndUs) {
      return t("settings.composition_duration_below_floor", {
        floor: floorDisplay,
      });
    }
    return null;
  };

  const togglePin = async (next: boolean) => {
    if (!composition || busy) return;
    setBusy(true);
    onError("");
    setLocalError(null);
    try {
      if (next) {
        // Pin at the current auto-fitted value — the user can edit the
        // input afterward to change it.
        await setComposition({ duration_us: composition.durationUs });
      } else {
        await fitCompositionToLayers();
      }
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!composition || busy || draft === null) return;
    // Live validation already populated localError on every keystroke;
    // if it's set, refuse to commit. The IPC layer would reject below-
    // floor values anyway (overflow guard), but bailing early keeps the
    // history clean.
    if (localError !== null) return;
    const parsed = parseTimecode(draft, composition.fpsNum, composition.fpsDen);
    if (parsed === null) return;
    if (parsed === composition.durationUs) {
      // No-op commit — just clear the draft state.
      setDraft(null);
      return;
    }
    setBusy(true);
    onError("");
    try {
      await setComposition({ duration_us: parsed });
      await onChanged();
      setDraft(null);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-pin-row">
        <label className="settings-pin-checkbox">
          <AppSwitch
            checked={pinned}
            disabled={disabled}
            onCheckedChange={(next) => {
              void togglePin(next);
            }}
          />
          <span className="settings-toggle-label">
            {t("settings.pin_composition_duration")}
          </span>
        </label>
        <AppInput id="composition-duration" value={draft ?? displayValue} disabled={disabled || !pinned}
          spellCheck={false} mono align="center" invalid={!!localError} className="settings-input"
          ariaLabel={t("settings.composition_duration_label")}
          onValueChange={(v) => { setDraft(v); setLocalError(validateDraft(v)); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              // Consume: this Escape reverts the draft only; without
              // stopPropagation the Settings dialog would close too.
              e.stopPropagation();
              setDraft(null);
              setLocalError(null);
            }
          }}
          onBlur={() => { if (draft !== null) void commit(); }}
          aria-invalid={localError !== null}
          aria-describedby={
            localError ? "composition-duration-error" : "composition-duration-hint"
          } />
      </div>
      {localError ? (
        <p
          id="composition-duration-error"
          className="settings-error"
          role="alert"
        >
          {localError}
        </p>
      ) : (
        <p
          id="composition-duration-hint"
          className="settings-toggle-hint"
        >
          {t("settings.pin_composition_duration_hint", { floor: floorDisplay })}
        </p>
      )}
      {durationWallClock !== null && (
        <p className="settings-toggle-hint">
          {t("settings.duration_wall_clock", {
            tc: displayValue,
            wall: durationWallClock,
          })}
          {floorWallClock !== null
            ? ` ${t("settings.content_end_wall_clock", { tc: floorDisplay, wall: floorWallClock })}`
            : ""}
        </p>
      )}
    </>
  );
}

/// Transcription / Speech pane. Fetches the full backend listing (engine
/// preference + per-backend availability, merged with the local config store),
/// renders the engine selector, then one row per backend by locality: cloud →
/// the existing `ApiKeyRow` (key), local → `LocalBackendRow` (binary/model
/// paths + device/threads). Self-fetches on mount (the pane stays mounted and
/// toggles via `hidden`, so the effect runs once) and re-fetches after any
/// mutation so badges + the "active engine" hint stay live.
function SpeechSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<SpeechBackendsView | null>(null);

  const refresh = async () => {
    try {
      setView(await settingsGetSpeechBackends());
    } catch (e) {
      onError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (view === null) {
    return (
      <section className="settings-section">
        <p className="settings-status">…</p>
      </section>
    );
  }

  // The backend the resolver would use right now (null → nothing configured).
  const active = view.backends.find((b) => b.selected) ?? null;

  return (
    <>
      <section className="settings-section">
        <p className="settings-blurb">{t("settings.speech_blurb")}</p>
        <label className="settings-toggle-row">
          <AppSelect
            value={view.preferred_engine}
            onValueChange={async (next) => {
              onError("");
              try {
                await settingsSetSpeechPreferred(next as PreferredEngine);
                await refresh();
              } catch (e) {
                onError(String(e));
              }
            }}
            options={speechEngineOptions(t, view.backends)}
            ariaLabel={t("settings.speech_engine")}
          />
          <span>
            <span className="settings-toggle-label">
              {t("settings.speech_engine")}
            </span>
            <span className="settings-toggle-hint">
              {active
                ? t("settings.speech_engine_active", { engine: active.label })
                : t("settings.speech_engine_none")}
            </span>
          </span>
        </label>
      </section>
      <section className="settings-section">
        {view.backends.map((b) =>
          b.locality === "cloud" ? (
            <ApiKeyRow
              key={b.backend}
              status={{
                provider: b.backend,
                label: b.label,
                configured: b.availability === "available",
              }}
              onChanged={refresh}
              onError={onError}
            />
          ) : (
            <LocalBackendRow
              key={b.backend}
              info={b}
              onChanged={refresh}
              onError={onError}
            />
          ),
        )}
      </section>
    </>
  );
}

/// Localized label for an availability verdict → the row's badge text.
function availabilityLabel(
  t: ReturnType<typeof useTranslation>["t"],
  a: SpeechBackendInfo["availability"],
): string {
  switch (a) {
    case "available":
      return t("settings.speech_available");
    case "needs_key":
      return t("settings.speech_needs_key");
    case "needs_binary":
      return t("settings.speech_needs_binary");
    case "needs_model":
      return t("settings.speech_needs_model");
  }
}

/// Local backends whose model bundle includes a `tokens.txt` (FunASR's
/// sherpa-onnx Paraformer needs `--tokens=`). Such a row shows a third path
/// picker and requires it to save; whisper.cpp (not listed) shows binary+model
/// only. Data-driven so a future tokens-using engine only joins this set.
const NEEDS_TOKENS: ReadonlySet<string> = new Set(["funasr"]);

/// One LOCAL engine's config row: binary + model path pickers (native dialog),
/// a tokens picker for engines in `NEEDS_TOKENS` (FunASR), optional device +
/// threads, plus Save / Clear / Test. Test routes through the generalized
/// `settings_test_provider` → `--help` liveness against the SAVED config, so
/// it is disabled while the edit buffers are dirty (unsaved paths would make
/// its verdict lie about what is on screen).
function LocalBackendRow({
  info,
  onChanged,
  onError,
}: {
  info: SpeechBackendInfo;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const needsTokens = NEEDS_TOKENS.has(info.backend);
  const [binary, setBinary] = useState(info.local?.binary ?? "");
  const [model, setModel] = useState(info.local?.model ?? "");
  const [tokens, setTokens] = useState(info.local?.tokens ?? "");
  const [device, setDevice] = useState(info.local?.device ?? "");
  const [threads, setThreads] = useState<number | null>(
    info.local?.threads ?? null,
  );
  const [busy, setBusy] = useState<"save" | "clear" | "test" | null>(null);
  const [flash, setFlash] = useState<"saved" | "cleared" | null>(null);
  const [testResult, setTestResult] = useState<
    { kind: "ok"; summary: string } | { kind: "err"; message: string } | null
  >(null);

  // Resync the edit buffers when the upstream stored config changes (after a
  // Save round-trip re-fetches, or a Clear).
  useEffect(() => {
    setBinary(info.local?.binary ?? "");
    setModel(info.local?.model ?? "");
    setTokens(info.local?.tokens ?? "");
    setDevice(info.local?.device ?? "");
    setThreads(info.local?.threads ?? null);
  }, [
    info.local?.binary,
    info.local?.model,
    info.local?.tokens,
    info.local?.device,
    info.local?.threads,
  ]);

  const browse = async (which: "binary" | "model" | "tokens") => {
    onError("");
    try {
      const picked = await openFileDialog({
        title:
          which === "binary"
            ? t("settings.speech_pick_binary")
            : which === "model"
              ? t("settings.speech_pick_model")
              : t("settings.speech_pick_tokens"),
      });
      if (typeof picked === "string") {
        if (which === "binary") setBinary(picked);
        else if (which === "model") setModel(picked);
        else setTokens(picked);
      }
    } catch (e) {
      onError(String(e));
    }
  };

  // FunASR can't run without its tokens.txt (availability reports NeedsModel
  // without it), so require it to save when the engine needs one.
  const canSave =
    binary.trim() !== "" &&
    model.trim() !== "" &&
    (!needsTokens || tokens.trim() !== "");

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    onError("");
    setTestResult(null);
    try {
      await settingsSetLocalBackend({
        backend: info.backend,
        binary: binary.trim(),
        model: model.trim(),
        ...(needsTokens && tokens.trim() !== "" ? { tokens: tokens.trim() } : {}),
        ...(device.trim() !== "" ? { device: device.trim() } : {}),
        ...(threads != null ? { threads } : {}),
      });
      setFlash("saved");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    onError("");
    setTestResult(null);
    try {
      await settingsClearLocalBackend(info.backend);
      setFlash("cleared");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setTestResult(null);
    onError("");
    try {
      const r = await settingsTestProvider(info.backend);
      setTestResult({ kind: "ok", summary: r.summary });
    } catch (e) {
      setTestResult({ kind: "err", message: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const available = info.availability === "available";

  // Test probes the SAVED config (the Rust-side cache), not these edit
  // buffers — so gate it while they differ (or nothing is saved yet), or its
  // verdict would contradict the paths on screen.
  const dirty =
    binary !== (info.local?.binary ?? "") ||
    model !== (info.local?.model ?? "") ||
    tokens !== (info.local?.tokens ?? "") ||
    device !== (info.local?.device ?? "") ||
    (threads ?? null) !== (info.local?.threads ?? null);
  const canTest = info.local !== undefined && !dirty;

  return (
    <div className="settings-key-row">
      <div className="settings-key-header">
        <span className="settings-key-label">{info.label}</span>
        <span
          className={
            available
              ? "settings-badge settings-badge-on"
              : "settings-badge settings-badge-off"
          }
        >
          {availabilityLabel(t, info.availability)}
        </span>
        {info.capabilities.exactWordTiming && (
          <span
            className="settings-badge settings-badge-off"
            title={t("settings.speech_exact_words_hint")}
          >
            {t("settings.speech_exact_words")}
          </span>
        )}
      </div>
      <div className="settings-key-input-row">
        <span className="settings-slider-label">
          {t("settings.speech_binary")}
        </span>
        <AppInput
          mono
          spellCheck={false}
          value={binary}
          placeholder={t("settings.speech_binary_placeholder")}
          disabled={busy !== null}
          onValueChange={setBinary}
          ariaLabel={t("settings.speech_binary")}
        />
        <Button
          size="sm"
          onClick={() => void browse("binary")}
          disabled={busy !== null}
        >
          {t("settings.speech_browse")}
        </Button>
      </div>
      <div className="settings-key-input-row">
        <span className="settings-slider-label">
          {t("settings.speech_model")}
        </span>
        <AppInput
          mono
          spellCheck={false}
          value={model}
          placeholder={t("settings.speech_model_placeholder")}
          disabled={busy !== null}
          onValueChange={setModel}
          ariaLabel={t("settings.speech_model")}
        />
        <Button
          size="sm"
          onClick={() => void browse("model")}
          disabled={busy !== null}
        >
          {t("settings.speech_browse")}
        </Button>
      </div>
      {needsTokens && (
        <div className="settings-key-input-row">
          <span className="settings-slider-label">
            {t("settings.speech_tokens")}
          </span>
          <AppInput
            mono
            spellCheck={false}
            value={tokens}
            placeholder={t("settings.speech_tokens_placeholder")}
            disabled={busy !== null}
            onValueChange={setTokens}
            ariaLabel={t("settings.speech_tokens")}
          />
          <Button
            size="sm"
            onClick={() => void browse("tokens")}
            disabled={busy !== null}
          >
            {t("settings.speech_browse")}
          </Button>
        </div>
      )}
      <div className="settings-key-input-row">
        <span className="settings-slider-label">
          {t("settings.speech_device")}
        </span>
        <AppInput
          spellCheck={false}
          value={device}
          placeholder={t("settings.speech_device_placeholder")}
          disabled={busy !== null}
          onValueChange={setDevice}
          ariaLabel={t("settings.speech_device")}
        />
        <span className="settings-slider-label">
          {t("settings.speech_threads")}
        </span>
        <AppNumberField
          value={threads}
          min={1}
          max={64}
          align="center"
          className="settings-input-narrow"
          disabled={busy !== null}
          ariaLabel={t("settings.speech_threads")}
          onValueChange={(v) => setThreads(v)}
          onClear={() => setThreads(null)}
        />
      </div>
      <div className="settings-key-input-row">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy !== null || !canSave}
        >
          {busy === "save"
            ? t("settings.saving")
            : flash === "saved"
              ? t("settings.saved")
              : t("settings.save")}
        </Button>
        <Button
          size="sm"
          onClick={() => void clear()}
          disabled={busy !== null || info.local === undefined}
        >
          {busy === "clear"
            ? t("settings.clearing")
            : flash === "cleared"
              ? t("settings.cleared")
              : t("settings.clear")}
        </Button>
        <Button
          size="sm"
          onClick={() => void test()}
          disabled={busy !== null || !canTest}
          title={
            canTest
              ? t("settings.speech_test_hint")
              : t("settings.speech_test_unsaved_hint")
          }
        >
          {busy === "test" ? t("settings.testing") : t("settings.test")}
        </Button>
      </div>
      {testResult && (
        <p
          className={
            testResult.kind === "ok" ? "settings-test-ok" : "settings-test-err"
          }
        >
          {testResult.kind === "ok"
            ? `✓ ${testResult.summary}`
            : `✗ ${testResult.message}`}
        </p>
      )}
    </div>
  );
}

function ApiKeyRow({
  status,
  onChanged,
  onError,
}: {
  status: ApiKeyStatus;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | "test" | null>(null);
  const [flash, setFlash] = useState<"saved" | "cleared" | null>(null);
  const [testResult, setTestResult] = useState<
    | { kind: "ok"; summary: string }
    | { kind: "err"; message: string }
    | null
  >(null);

  const save = async () => {
    if (!value.trim()) return;
    setBusy("save");
    onError("");
    try {
      await settingsSetApiKey(status.provider, value.trim());
      setValue("");
      setFlash("saved");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    onError("");
    setTestResult(null);
    try {
      await settingsClearApiKey(status.provider);
      setFlash("cleared");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setTestResult(null);
    onError("");
    try {
      const info = await settingsTestProvider(status.provider);
      setTestResult({ kind: "ok", summary: info.summary });
    } catch (e) {
      setTestResult({ kind: "err", message: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-key-row">
      <div className="settings-key-header">
        <span className="settings-key-label">{status.label}</span>
        <span
          className={
            status.configured
              ? "settings-badge settings-badge-on"
              : "settings-badge settings-badge-off"
          }
        >
          {status.configured
            ? t("settings.configured")
            : t("settings.not_configured")}
        </span>
      </div>
      <div className="settings-key-input-row">
        <AppInput type="password" mono autoComplete="off" spellCheck={false} value={value}
          placeholder={
            status.configured
              ? t("settings.placeholder_set")
              : t("settings.placeholder_unset")
          }
          disabled={busy !== null}
          onValueChange={setValue} />
        <Button
          size="sm"
          onClick={save}
          disabled={busy !== null || value.trim() === ""}
        >
          {busy === "save"
            ? t("settings.saving")
            : flash === "saved"
              ? t("settings.saved")
              : t("settings.save")}
        </Button>
        <Button
          size="sm"
          onClick={clear}
          disabled={busy !== null || !status.configured}
        >
          {busy === "clear"
            ? t("settings.clearing")
            : flash === "cleared"
              ? t("settings.cleared")
              : t("settings.clear")}
        </Button>
        <Button
          size="sm"
          onClick={test}
          disabled={busy !== null || !status.configured}
          title={t("settings.test_hint")}
        >
          {busy === "test" ? t("settings.testing") : t("settings.test")}
        </Button>
      </div>
      {testResult && (
        <p
          className={
            testResult.kind === "ok"
              ? "settings-test-ok"
              : "settings-test-err"
          }
        >
          {testResult.kind === "ok"
            ? `✓ ${testResult.summary}`
            : `✗ ${testResult.message}`}
        </p>
      )}
    </div>
  );
}
