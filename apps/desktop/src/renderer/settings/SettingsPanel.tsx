import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  type ApiKeyStatus,
  type KeybindingsMap,
  fitCompositionToLayers,
  getProjectSettings,
  recentsGetReopenOnLaunch,
  recentsSetReopenOnLaunch,
  setComposition,
  settingsClearApiKey,
  settingsGetApiKeyStatus,
  settingsSetApiKey,
  settingsTestProvider,
  updateProjectSettings,
} from "../ipc";
import { formatTimecode, parseTimecode } from "../frames";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { AppSlider } from "../components/AppSlider";
import { AppSwitch } from "../components/AppSwitch";
import { Button } from "@/components/ui/button";
import { KeybindingPanel } from "./KeybindingPanel";
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
  keybindings,
  onKeybindingsChanged,
  composition,
  onCompositionChanged,
}: Props) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<ApiKeyStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopenOnLaunch, setReopenOnLaunch] = useState<boolean | null>(null);
  const [category, setCategory] = useState<SettingsCategory>("general");
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

  const refresh = async () => {
    try {
      const next = await settingsGetApiKeyStatus();
      setStatuses(next);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
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
            <section className="settings-section">
              <p className="settings-blurb">{t("settings.api_keys_blurb")}</p>

              {statuses === null ? (
                <p className="settings-status">…</p>
              ) : (
                statuses.map((s) => (
                  <ApiKeyRow
                    key={s.provider}
                    status={s}
                    onChanged={refresh}
                    onError={setError}
                  />
                ))
              )}
            </section>
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
        options={[
          { value: "auto", label: t("settings.decode_engine_auto") },
          {
            value: "ffmpeg",
            label: (
              <>
                {t("settings.decode_engine_ffmpeg")}
                <span
                  style={{ marginLeft: 6, fontSize: 12, color: "var(--muted-foreground)" }}
                >
                  {t("settings.decode_engine_ffmpeg_tag")}
                </span>
                {!componentAvailable &&
                  ` — ${t("settings.decode_engine_unavailable_suffix")}`}
              </>
            ),
            disabled: !componentAvailable,
          },
          {
            value: "webcodecs",
            label: (
              <>
                {t("settings.decode_engine_webcodecs")}
                <span
                  style={{ marginLeft: 6, fontSize: 12, color: "var(--muted-foreground)" }}
                >
                  {t("settings.decode_engine_webcodecs_tag")}
                </span>
              </>
            ),
          },
        ]}
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
    </>
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
