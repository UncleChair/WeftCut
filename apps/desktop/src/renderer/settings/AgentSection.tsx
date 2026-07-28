import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getMcpInfo, resetMcpToken, type McpInfoView } from "../ipc";
import { Button } from "@/components/ui/button";

const REFRESH_INTERVAL_MS = 1000;

/// MCP connection info for external agents (URL, bearer token, config
/// snippet). Lives in the Settings "Agent" tab; like the other panes it
/// stays mounted across tab switches, so the poll below runs once.
export function AgentSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpInfoView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Poll until the MCP server is up. Once we have info, stop polling.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const next = await getMcpInfo();
        if (cancelled) return;
        if (next) {
          setInfo(next);
          return;
        }
      } catch {
        // ignore — server might still be starting
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, REFRESH_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  const snippet = useMemo(() => {
    if (!info) return "";
    return JSON.stringify(
      {
        mcpServers: {
          weftcut: {
            url: info.url,
            headers: { Authorization: `Bearer ${info.bearer_token}` },
          },
        },
      },
      null,
      2,
    );
  }, [info]);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((cur) => (cur === key ? null : cur)), 1500);
    } catch (e) {
      console.warn("clipboard copy failed:", e);
    }
  };

  const refreshToken = async () => {
    if (refreshing) return;
    if (!window.confirm(t("connect.refresh_confirm"))) return;
    setRefreshing(true);
    try {
      const next = await resetMcpToken();
      // Splice the new token into the cached view so every snippet recomputes
      // without waiting on the next getMcpInfo poll (the poll already stopped).
      setInfo((prev) => (prev ? { ...prev, bearer_token: next } : prev));
      // Auto-reveal so the user can immediately copy the new value into their
      // agent config — the refresh just invalidated what they had.
      setRevealed(true);
    } catch (e) {
      console.warn("reset bearer failed:", e);
    } finally {
      setRefreshing(false);
    }
  };

  if (!info) {
    return <p className="connect-status">{t("connect.starting")}</p>;
  }

  return (
    <>
      <p className="connect-blurb">{t("connect.blurb")}</p>

      <ConnectField
        label={t("connect.field.url")}
        value={info.url}
        onCopy={() => copy("url", info.url)}
        copied={copied === "url"}
        copyLabel={t("connect.copy")}
        copiedLabel={t("connect.copied")}
      />
      <ConnectField
        label={t("connect.field.bearer")}
        value={revealed ? info.bearer_token : "••••••••••••••••"}
        onCopy={() => copy("bearer", info.bearer_token)}
        copied={copied === "bearer"}
        copyLabel={t("connect.copy")}
        copiedLabel={t("connect.copied")}
        extraButton={
          <>
            <Button size="sm" onClick={() => setRevealed((r) => !r)}>
              {revealed ? t("connect.hide") : t("connect.reveal")}
            </Button>
            <Button
              size="sm"
              onClick={refreshToken}
              disabled={refreshing}
              title={t("connect.refresh_hint")}
            >
              {refreshing ? t("connect.refreshing") : t("connect.refresh")}
            </Button>
          </>
        }
      />

      <h3>{t("connect.snippets_heading")}</h3>

      <ConnectSnippet
        label={t("connect.snippet.config")}
        value={snippet}
        onCopy={() => copy("config", snippet)}
        copied={copied === "config"}
        copyLabel={t("connect.copy")}
        copiedLabel={t("connect.copied")}
      />

      <p className="connect-note">{t("connect.token_note")}</p>
    </>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  copyLabel: string;
  copiedLabel: string;
  extraButton?: ReactNode;
}

function ConnectField({
  label,
  value,
  onCopy,
  copied,
  copyLabel,
  copiedLabel,
  extraButton,
}: FieldProps) {
  return (
    <div className="connect-field">
      <span className="connect-field-label">{label}</span>
      <div className="connect-field-row">
        <code className="connect-value">{value}</code>
        <Button size="sm" onClick={onCopy}>
          {copied ? copiedLabel : copyLabel}
        </Button>
        {extraButton}
      </div>
    </div>
  );
}

interface SnippetProps {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  copyLabel: string;
  copiedLabel: string;
}

function ConnectSnippet({
  label,
  value,
  onCopy,
  copied,
  copyLabel,
  copiedLabel,
}: SnippetProps) {
  return (
    <div className="connect-snippet">
      <div className="connect-snippet-header">
        <span>{label}</span>
        <Button size="sm" onClick={onCopy}>
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}
