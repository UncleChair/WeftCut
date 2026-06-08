import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ApiKeyStatus,
  type KeybindingsMap,
  fitCompositionToLayers,
  recentsGetReopenOnLaunch,
  recentsSetReopenOnLaunch,
  setComposition,
  settingsClearApiKey,
  settingsGetApiKeyStatus,
  settingsSetApiKey,
  settingsTestProvider,
} from "../ipc";
import { formatTimecode, parseTimecode } from "../frames";
import { KeybindingPanel } from "./KeybindingPanel";
import {
  setAppSettings,
  usePrebakeMotifsEnabled,
  useTailSnapEnabled,
  useTailSnapStrengthPx,
} from "./appSettingsStore";

const TAIL_SNAP_MIN_PX = 2;
const TAIL_SNAP_MAX_PX = 80;

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
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="settings-panel">
        <header>
          <h2>{t("settings.heading")}</h2>
          <button
            className="settings-close"
            onClick={onClose}
            aria-label={t("settings.close")}
          >
            ✕
          </button>
        </header>

        <div className="settings-body">
        <div className="settings-card">
        <h3>{t("settings.startup_heading")}</h3>
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={reopenOnLaunch === true}
            disabled={reopenOnLaunch === null}
            onChange={async (e) => {
              const next = e.target.checked;
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

        <h3>{t("settings.composition_heading")}</h3>
        <p className="settings-blurb">{t("settings.composition_blurb")}</p>
        <CompositionSection
          composition={composition}
          onChanged={onCompositionChanged}
          onError={setError}
        />

        <h3>{t("settings.timeline_heading")}</h3>
        <p className="settings-blurb">{t("settings.timeline_blurb")}</p>
        <TimelineSnapSection onError={setError} />

        <h3>{t("settings.templates_heading")}</h3>
        <PrebakeSection onError={setError} />

        <h3>{t("settings.keybindings_heading")}</h3>
        <p className="settings-blurb">{t("settings.keybindings_blurb")}</p>
        <KeybindingPanel
          keybindings={keybindings}
          onChanged={onKeybindingsChanged}
          onError={setError}
        />

        <h3>{t("settings.api_keys_heading")}</h3>
        <p className="settings-blurb">{t("settings.api_keys_blurb")}</p>

        {error && <p className="settings-error">{error}</p>}

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
        </div>
        </div>
      </div>
    </div>
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

  const clampStrength = (value: number): number =>
    Math.round(Math.min(TAIL_SNAP_MAX_PX, Math.max(TAIL_SNAP_MIN_PX, value)));

  const commitStrength = async (value: number) => {
    const next = clampStrength(value);
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
        <input
          type="checkbox"
          checked={enabled}
          onChange={async (e) => {
            const next = e.target.checked;
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
        <input
          type="range"
          min={TAIL_SNAP_MIN_PX}
          max={TAIL_SNAP_MAX_PX}
          value={draftStrengthPx}
          disabled={!enabled}
          onChange={(e) => setDraftStrengthPx(Number(e.target.value))}
          onPointerUp={(e) => {
            void commitStrength(Number(e.currentTarget.value));
          }}
          onKeyUp={(e) => {
            if (
              e.key === "ArrowLeft" ||
              e.key === "ArrowRight" ||
              e.key === "Home" ||
              e.key === "End"
            ) {
              void commitStrength(Number(e.currentTarget.value));
            }
          }}
          onBlur={(e) => {
            void commitStrength(Number(e.currentTarget.value));
          }}
          aria-label={t("settings.tail_snap_strength")}
        />
        <input
          type="number"
          className="settings-input settings-input-narrow"
          min={TAIL_SNAP_MIN_PX}
          max={TAIL_SNAP_MAX_PX}
          value={draftStrengthPx}
          disabled={!enabled}
          onChange={(e) => setDraftStrengthPx(Number(e.target.value))}
          onBlur={(e) => {
            void commitStrength(Number(e.currentTarget.value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitStrength(Number(e.currentTarget.value));
            }
          }}
          aria-label={t("settings.tail_snap_strength")}
        />
        <span className="settings-slider-unit">px</span>
      </div>
      <p className="settings-toggle-hint">
        {t("settings.tail_snap_strength_hint")}
      </p>
    </>
  );
}

function PrebakeSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const enabled = usePrebakeMotifsEnabled();
  return (
    <label className="settings-toggle-row">
      <input
        type="checkbox"
        checked={enabled}
        onChange={async (e) => {
          const next = e.target.checked;
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
          <input
            type="checkbox"
            checked={pinned}
            disabled={disabled}
            onChange={(e) => {
              void togglePin(e.target.checked);
            }}
          />
          <span className="settings-toggle-label">
            {t("settings.pin_composition_duration")}
          </span>
        </label>
        <input
          id="composition-duration"
          type="text"
          className={`settings-input ${localError ? "is-invalid" : ""}`}
          value={draft ?? displayValue}
          disabled={disabled || !pinned}
          spellCheck={false}
          aria-label={t("settings.composition_duration_label")}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            setLocalError(validateDraft(v));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
              setLocalError(null);
            }
          }}
          onBlur={() => {
            if (draft !== null) void commit();
          }}
          aria-invalid={localError !== null}
          aria-describedby={
            localError ? "composition-duration-error" : "composition-duration-hint"
          }
        />
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
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            status.configured
              ? t("settings.placeholder_set")
              : t("settings.placeholder_unset")
          }
          disabled={busy !== null}
        />
        <button
          type="button"
          onClick={save}
          disabled={busy !== null || value.trim() === ""}
        >
          {busy === "save"
            ? t("settings.saving")
            : flash === "saved"
              ? t("settings.saved")
              : t("settings.save")}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={busy !== null || !status.configured}
        >
          {busy === "clear"
            ? t("settings.clearing")
            : flash === "cleared"
              ? t("settings.cleared")
              : t("settings.clear")}
        </button>
        <button
          type="button"
          onClick={test}
          disabled={busy !== null || !status.configured}
          title={t("settings.test_hint")}
        >
          {busy === "test" ? t("settings.testing") : t("settings.test")}
        </button>
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
