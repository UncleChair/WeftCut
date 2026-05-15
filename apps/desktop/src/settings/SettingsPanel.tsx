import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ApiKeyStatus,
  type KeybindingsMap,
  recentsGetReopenOnLaunch,
  recentsSetReopenOnLaunch,
  settingsClearApiKey,
  settingsGetApiKeyStatus,
  settingsSetApiKey,
  settingsTestProvider,
} from "../ipc";
import { KeybindingPanel } from "./KeybindingPanel";
import {
  resolveEffectiveMode,
  usePreviewModeCapability,
  usePreviewModePreference,
  useSetPreviewModePreference,
  type PreviewModePreference,
} from "../preview/webcodecs/previewModeStore";

interface Props {
  onClose: () => void;
  /// Shortcut overrides owned by App.tsx. Threaded through so the
  /// Keyboard section can render the current bindings and the
  /// dispatcher re-resolves the moment the user edits.
  keybindings: KeybindingsMap;
  onKeybindingsChanged: (next: KeybindingsMap) => void;
}

export function SettingsPanel({
  onClose,
  keybindings,
  onKeybindingsChanged,
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

        <h3>{t("settings.keybindings_heading")}</h3>
        <p className="settings-blurb">{t("settings.keybindings_blurb")}</p>
        <KeybindingPanel
          keybindings={keybindings}
          onChanged={onKeybindingsChanged}
          onError={setError}
        />

        <h3>{t("settings.preview_engine_heading", "Preview engine")}</h3>
        <p className="settings-blurb">
          {t(
            "settings.preview_engine_blurb",
            "Real-time playback uses WebCodecs + WebGL2 for instant edit feedback; cached uses pre-rendered segments. Auto picks based on a capability probe.",
          )}
        </p>
        <PreviewEngineSection />

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
  );
}

function PreviewEngineSection() {
  const { t } = useTranslation();
  const preference = usePreviewModePreference();
  const capability = usePreviewModeCapability();
  const setPreference = useSetPreviewModePreference();
  const effective = resolveEffectiveMode(preference, capability);

  const options: Array<{
    value: PreviewModePreference;
    label: string;
    hint: string;
  }> = [
    {
      value: "auto",
      label: t("settings.preview_mode.auto", "Auto (recommended)"),
      hint: t(
        "settings.preview_mode.auto_hint",
        "Real-time when the capability probe passes; cached otherwise.",
      ),
    },
    {
      value: "realtime",
      label: t("settings.preview_mode.realtime", "Real-time"),
      hint: t(
        "settings.preview_mode.realtime_hint",
        "Force WebCodecs + WebGL2. Falls back to cached only when the decoder is entirely absent.",
      ),
    },
    {
      value: "cached",
      label: t("settings.preview_mode.cached", "Cached"),
      hint: t(
        "settings.preview_mode.cached_hint",
        "Always use pre-rendered segments. Bug-report escape hatch.",
      ),
    },
  ];

  return (
    <div className="settings-preview-engine">
      <div className="settings-preview-options" role="radiogroup">
        {options.map((opt) => (
          <label key={opt.value} className="settings-preview-option">
            <input
              type="radio"
              name="previewMode"
              value={opt.value}
              checked={preference === opt.value}
              onChange={() => setPreference(opt.value)}
            />
            <span>
              <span className="settings-toggle-label">{opt.label}</span>
              <span className="settings-toggle-hint">{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="settings-preview-status">
        <strong>{t("settings.preview_capability", "Capability probe")}:</strong>{" "}
        {capability ? (
          capability.ok ? (
            <span className="settings-badge settings-badge-on">
              {t("settings.preview_capability_ok", "ok — all stages passed")}
            </span>
          ) : (
            <span className="settings-badge settings-badge-off">
              {capability.stage}: {capability.detail}
            </span>
          )
        ) : (
          <span>{t("settings.preview_capability_probing", "probing…")}</span>
        )}
        <div>
          <strong>{t("settings.preview_effective", "Effective engine")}:</strong>{" "}
          <code>{effective}</code>
        </div>
      </div>
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
