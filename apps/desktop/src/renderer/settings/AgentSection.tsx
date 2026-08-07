import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
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
/// its own snippet tab; `generic` is the catch-all shape.
type ClientId = "codex" | "claude" | "cursor" | "generic";
const CLIENTS: readonly ClientId[] = ["codex", "claude", "cursor", "generic"];

/// The stdio launch triple for the shim. `command` is the WeftCut binary
/// acting as the Node runtime (ELECTRON_RUN_AS_NODE) — or the .AppImage file
/// on Linux, where the mounted binary path dies with the session.
interface StdioCfg {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function stdioCfgFrom(info: McpInfoView): StdioCfg | null {
  if (!info.shim_path) return null;
  return {
    command: info.appimage ?? info.exe_path,
    args: [info.shim_path],
    env: { ELECTRON_RUN_AS_NODE: "1", WEFTCUT_USERDATA: info.user_data },
  };
}

/// Ready-to-paste stdio config for one client. JSON.stringify doubles as the
/// TOML basic-string encoder — TOML's escape set is a superset of JSON's, so
/// Windows backslash paths survive both formats.
function buildStdioSnippet(client: ClientId, cfg: StdioCfg): string {
  if (client === "codex") {
    const env = Object.entries(cfg.env)
      .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
      .join(", ");
    return [
      "[mcp_servers.weftcut]",
      `command = ${JSON.stringify(cfg.command)}`,
      `args = [${cfg.args.map((a) => JSON.stringify(a)).join(", ")}]`,
      `env = { ${env} }`,
    ].join("\n");
  }
  const server = client === "claude" ? { type: "stdio", ...cfg } : cfg;
  return JSON.stringify({ mcpServers: { weftcut: server } }, null, 2);
}

/// Ready-to-paste HTTP-direct config for one client (the advanced path).
/// Formats follow each client's official docs:
/// - codex:   `~/.codex/config.toml`, `[mcp_servers.<name>]` table; HTTP
///   servers declare `url` + static `http_headers` (no inline bearer field).
/// - claude:  `.mcp.json` / `~/.claude.json`; a `url` entry is an error
///   without `"type": "http"`.
/// - cursor:  `~/.cursor/mcp.json`; `url` + `headers`, no `type` field.
/// - generic: same shape as cursor — the de-facto streamable-HTTP snippet.
function buildHttpSnippet(client: ClientId, url: string, token: string): string {
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

/// MCP connection info for external agents. Two connection paths: the stdio
/// shim (primary — survives app restarts, port changes, token rotations, and
/// the app being closed) and HTTP-direct (advanced — for clients without
/// stdio support). Until the shim is installed (dev before build:cli,
/// shim_path = null) the HTTP path renders as primary, which is also the
/// pre-shim layout. Lives in the Settings "Agent" tab; like the other panes
/// it stays mounted across tab switches, so the poll below runs once.
export function AgentSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpInfoView | null>(null);
  const [client, setClient] = useState<ClientId>("codex");
  const [revealed, setRevealed] = useState(false);
  const [stdioCopied, setStdioCopied] = useState(false);
  const [httpCopied, setHttpCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [httpOpen, setHttpOpen] = useState(false);

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

  const stdio = useMemo(() => (info ? stdioCfgFrom(info) : null), [info]);

  const stdioSnippet = useMemo(
    () => (stdio ? buildStdioSnippet(client, stdio) : ""),
    [stdio, client],
  );

  // Displayed HTTP snippet masks the token unless revealed; the copy below
  // always uses the real one.
  const httpSnippet = useMemo(() => {
    if (!info) return "";
    return buildHttpSnippet(
      client,
      info.url,
      revealed ? info.bearer_token : MASKED_TOKEN,
    );
  }, [info, client, revealed]);

  const copyStdio = async () => {
    if (!stdio) return;
    try {
      await navigator.clipboard.writeText(buildStdioSnippet(client, stdio));
      setStdioCopied(true);
      window.setTimeout(() => setStdioCopied(false), 1500);
    } catch (e) {
      console.warn("clipboard copy failed:", e);
    }
  };

  const copyHttp = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(
        buildHttpSnippet(client, info.url, info.bearer_token),
      );
      setHttpCopied(true);
      window.setTimeout(() => setHttpCopied(false), 1500);
    } catch (e) {
      console.warn("clipboard copy failed:", e);
    }
  };

  // The prompt is generic — the agent figures out its own client config
  // format. With the shim installed it carries the stdio triple (no token to
  // leak); without it, the URL + token as before.
  const copyAgentPrompt = async () => {
    if (!info) return;
    const prompt = stdio
      ? t("connect.agent_prompt_stdio", {
          command: stdio.command,
          args: stdio.args.join(" "),
          userData: info.user_data,
        })
      : t("connect.agent_prompt", {
          url: info.url,
          token: info.bearer_token,
        });
    try {
      await navigator.clipboard.writeText(prompt);
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1500);
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
    return <p className="settings-status">{t("connect.starting")}</p>;
  }

  /// One tablist per snippet block; both share the `client` selection so
  /// switching tabs in the primary block also switches the advanced one.
  const clientTabs = (section: string) => (
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
          id={`connect-tab-${section}-${id}`}
          aria-selected={client === id}
          aria-controls={`connect-snippet-panel-${section}`}
          tabIndex={client === id ? 0 : -1}
          className={client === id ? "connect-tab is-active" : "connect-tab"}
          onClick={() => setClient(id)}
        >
          {t(`connect.tabs.${id}`)}
        </button>
      ))}
    </div>
  );

  const httpActions = (copied: boolean) => (
    <div className="connect-snippet-actions">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void copyHttp()}
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
        aria-label={refreshing ? t("connect.refreshing") : t("connect.refresh")}
      >
        <RotateCcwIcon size={12} />
      </Button>
    </div>
  );

  const httpSnippetBlock = (section: string) => (
    <div
      className="connect-snippet"
      role="tabpanel"
      id={`connect-snippet-panel-${section}`}
      aria-labelledby={`connect-tab-${section}-${client}`}
    >
      <div className="connect-snippet-header">
        <span>{t(`connect.hint.${client}`)}</span>
        {httpActions(httpCopied)}
      </div>
      <pre>
        <code>{httpSnippet}</code>
      </pre>
    </div>
  );

  return (
    <>
      <p className="settings-blurb">{t("connect.blurb")}</p>
      <p className="settings-warn">{t("connect.token_note")}</p>

      <section className="settings-section">
        <h3>{t("connect.prompt_heading")}</h3>
        <p className="settings-blurb">{t("connect.prompt_blurb")}</p>
        <div className="settings-key-input-row">
          <Button size="sm" onClick={() => void copyAgentPrompt()}>
            {promptCopied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            {promptCopied
              ? t("connect.prompt_copied")
              : t("connect.copy_prompt")}
          </Button>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t("connect.manual_heading")}</h3>
        {stdio ? (
          <>
            <p className="settings-blurb">{t("connect.stdio_note")}</p>
            {clientTabs("stdio")}
            <div
              className="connect-snippet"
              role="tabpanel"
              id="connect-snippet-panel-stdio"
              aria-labelledby={`connect-tab-stdio-${client}`}
            >
              <div className="connect-snippet-header">
                <span>{t(`connect.hint_stdio.${client}`)}</span>
                <div className="connect-snippet-actions">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void copyStdio()}
                    title={stdioCopied ? t("connect.copied") : t("connect.copy")}
                    aria-label={
                      stdioCopied ? t("connect.copied") : t("connect.copy")
                    }
                  >
                    {stdioCopied ? (
                      <CheckIcon size={12} />
                    ) : (
                      <CopyIcon size={12} />
                    )}
                  </Button>
                </div>
              </div>
              <pre>
                <code>{stdioSnippet}</code>
              </pre>
            </div>
          </>
        ) : (
          <>
            {clientTabs("http")}
            {httpSnippetBlock("http")}
          </>
        )}
      </section>

      {stdio && (
        <section className="settings-section">
          <h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHttpOpen((o) => !o)}
              aria-expanded={httpOpen}
            >
              {httpOpen ? (
                <ChevronDownIcon size={13} />
              ) : (
                <ChevronRightIcon size={13} />
              )}
              {t("connect.http_heading")}
            </Button>
          </h3>
          {httpOpen && (
            <>
              <p className="settings-blurb">{t("connect.http_note")}</p>
              {clientTabs("http")}
              {httpSnippetBlock("http")}
            </>
          )}
        </section>
      )}
    </>
  );
}
