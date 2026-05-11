import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ApiKeyStatus,
  settingsClearApiKey,
  settingsGetApiKeyStatus,
  settingsSetApiKey,
  settingsTestProvider,
} from "../ipc";

interface Props {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<ApiKeyStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
