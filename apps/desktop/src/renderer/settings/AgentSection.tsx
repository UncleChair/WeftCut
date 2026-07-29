import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  RotateCcwIcon,
} from "lucide-react";
import { getMcpInfo, resetMcpToken, type McpInfoView } from "../ipc";
import { Button } from "@/components/ui/button";

const REFRESH_INTERVAL_MS = 1000;
const MASKED_TOKEN = "••••••••••••••••";

/// Agent clients with a known MCP config format, in sidebar order. Each gets
/// its own snippet tab; `generic` is the catch-all streamable-HTTP shape.
type ClientId = "codex" | "claude" | "cursor" | "generic";
const CLIENTS: readonly ClientId[] = ["codex", "claude", "cursor", "generic"];

/// Ready-to-paste MCP config for one client. Formats follow each client's
/// official docs:
/// - codex:   `~/.codex/config.toml`, `[mcp_servers.<name>]` table; HTTP
///   servers declare `url` + static `http_headers` (no inline bearer field).
/// - claude:  `.mcp.json` / `~/.claude.json`; a `url` entry is an error
///   without `"type": "http"`.
/// - cursor:  `~/.cursor/mcp.json`; `url` + `headers`, no `type` field.
/// - generic: same shape as cursor — the de-facto streamable-HTTP snippet.
function buildSnippet(client: ClientId, url: string, token: string): string {
  if (client === "codex") {
    return [
      "[mcp_servers.weftcut]",
      `url = "${url}"`,
      `http_headers = { "Authorization" = "Bearer ${token}" }`,
    ].join("\n");
  }
  const server =
    client === "claude"
      ? { type: "http", url, headers: { Authorization: `Bearer ${token}` } }
      : { url, headers: { Authorization: `Bearer ${token}` } };
  return JSON.stringify({ mcpServers: { weftcut: server } }, null, 2);
}

/// MCP connection info for external agents, rendered as one copyable config
/// snippet per client. Lives in the Settings "Agent" tab; like the other
/// panes it stays mounted across tab switches, so the poll below runs once.
export function AgentSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpInfoView | null>(null);
  const [client, setClient] = useState<ClientId>("codex");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
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

  // Displayed snippet masks the token unless revealed; the copy below always
  // uses the real one.
  const snippet = useMemo(() => {
    if (!info) return "";
    return buildSnippet(
      client,
      info.url,
      revealed ? info.bearer_token : MASKED_TOKEN,
    );
  }, [info, client, revealed]);

  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(
        buildSnippet(client, info.url, info.bearer_token),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
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

  /// Arrow keys move between client tabs (horizontal tablist).
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = CLIENTS.indexOf(client);
    let next: ClientId | undefined;
    if (e.key === "ArrowRight") next = CLIENTS[(idx + 1) % CLIENTS.length];
    else if (e.key === "ArrowLeft")
      next = CLIENTS[(idx - 1 + CLIENTS.length) % CLIENTS.length];
    if (next) {
      e.preventDefault();
      setClient(next);
    }
  };

  if (!info) {
    return <p className="connect-status">{t("connect.starting")}</p>;
  }

  return (
    <>
      <p className="connect-blurb">{t("connect.blurb")}</p>
      <p className="connect-note">{t("connect.token_note")}</p>

      <div
        className="connect-tabs"
        role="tablist"
        aria-label={t("connect.snippets_heading")}
        onKeyDown={onTabsKeyDown}
      >
        {CLIENTS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`connect-tab-${id}`}
            aria-selected={client === id}
            aria-controls="connect-snippet-panel"
            tabIndex={client === id ? 0 : -1}
            className={
              client === id ? "connect-tab is-active" : "connect-tab"
            }
            onClick={() => setClient(id)}
          >
            {t(`connect.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div
        className="connect-snippet"
        role="tabpanel"
        id="connect-snippet-panel"
        aria-labelledby={`connect-tab-${client}`}
      >
        <div className="connect-snippet-header">
          <span>{t(`connect.hint.${client}`)}</span>
          <div className="connect-snippet-actions">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void copy()}
              title={copied ? t("connect.copied") : t("connect.copy")}
              aria-label={copied ? t("connect.copied") : t("connect.copy")}
            >
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setRevealed((r) => !r)}
              title={revealed ? t("connect.hide") : t("connect.reveal")}
              aria-label={revealed ? t("connect.hide") : t("connect.reveal")}
            >
              {revealed ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void refreshToken()}
              disabled={refreshing}
              title={t("connect.refresh_hint")}
              aria-label={
                refreshing ? t("connect.refreshing") : t("connect.refresh")
              }
            >
              <RotateCcwIcon size={12} />
            </Button>
          </div>
        </div>
        <pre>
          <code>{snippet}</code>
        </pre>
      </div>
    </>
  );
}
