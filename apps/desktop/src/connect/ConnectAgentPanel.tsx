import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getMcpInfo, resetMcpToken, type McpInfoView } from "../ipc";
import { AppDialog } from "../components/AppDialog";

interface Props {
  onClose: () => void;
}

const REFRESH_INTERVAL_MS = 1000;

export function ConnectAgentPanel({ onClose }: Props) {
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

  const claudeSnippet = useMemo(() => {
    if (!info) return "";
    return JSON.stringify(
      {
        mcpServers: {
          weftcut: {
            url: info.sse_url,
            transport: "sse",
            headers: { Authorization: `Bearer ${info.bearer_token}` },
          },
        },
      },
      null,
      2,
    );
  }, [info]);

  const cursorSnippet = useMemo(() => {
    if (!info) return "";
    return JSON.stringify(
      {
        mcpServers: {
          weftcut: {
            url: info.sse_url,
            type: "sse",
            headers: { Authorization: `Bearer ${info.bearer_token}` },
          },
        },
      },
      null,
      2,
    );
  }, [info]);

  const curlLine = useMemo(() => {
    if (!info) return "";
    return `curl -N -H "Authorization: Bearer ${info.bearer_token}" ${info.sse_url}`;
  }, [info]);

  const eventsCurlLine = useMemo(() => {
    if (!info) return "";
    return `curl -N ${info.events_url}`;
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

  return (
    <AppDialog
      title={t("connect.heading")}
      onClose={onClose}
      closeLabel={t("connect.close")}
      panelClassName="connect-agent-panel"
    >
        <div className="connect-agent-body">
        {!info ? (
          <p className="connect-status">{t("connect.starting")}</p>
        ) : (
          <>
            <p className="connect-blurb">{t("connect.blurb")}</p>

            <ConnectField
              label={t("connect.field.sse_url")}
              value={info.sse_url}
              onCopy={() => copy("sse", info.sse_url)}
              copied={copied === "sse"}
              copyLabel={t("connect.copy")}
              copiedLabel={t("connect.copied")}
            />
            <ConnectField
              label={t("connect.field.events_url")}
              value={info.events_url}
              onCopy={() => copy("events", info.events_url)}
              copied={copied === "events"}
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
                  <button
                    type="button"
                    className="connect-reveal"
                    onClick={() => setRevealed((r) => !r)}
                  >
                    {revealed ? t("connect.hide") : t("connect.reveal")}
                  </button>
                  <button
                    type="button"
                    className="connect-refresh"
                    onClick={refreshToken}
                    disabled={refreshing}
                    title={t("connect.refresh_hint")}
                  >
                    {refreshing ? t("connect.refreshing") : t("connect.refresh")}
                  </button>
                </>
              }
            />

            <h3>{t("connect.snippets_heading")}</h3>

            <ConnectSnippet
              label={t("connect.snippet.claude")}
              value={claudeSnippet}
              onCopy={() => copy("claude", claudeSnippet)}
              copied={copied === "claude"}
              copyLabel={t("connect.copy")}
              copiedLabel={t("connect.copied")}
            />
            <ConnectSnippet
              label={t("connect.snippet.cursor")}
              value={cursorSnippet}
              onCopy={() => copy("cursor", cursorSnippet)}
              copied={copied === "cursor"}
              copyLabel={t("connect.copy")}
              copiedLabel={t("connect.copied")}
            />
            <ConnectSnippet
              label={t("connect.snippet.curl")}
              value={curlLine}
              onCopy={() => copy("curl", curlLine)}
              copied={copied === "curl"}
              copyLabel={t("connect.copy")}
              copiedLabel={t("connect.copied")}
            />
            <ConnectSnippet
              label={t("connect.snippet.events_curl")}
              value={eventsCurlLine}
              onCopy={() => copy("events_curl", eventsCurlLine)}
              copied={copied === "events_curl"}
              copyLabel={t("connect.copy")}
              copiedLabel={t("connect.copied")}
            />

            <p className="connect-note">{t("connect.token_note")}</p>
          </>
        )}
        </div>
    </AppDialog>
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
      <label>{label}</label>
      <div className="connect-field-row">
        <code className="connect-value">{value}</code>
        <button onClick={onCopy} type="button">
          {copied ? copiedLabel : copyLabel}
        </button>
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
        <button onClick={onCopy} type="button">
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}
