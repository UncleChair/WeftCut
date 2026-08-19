/** LogBus instrumentation for the MCP request funnel: one decorator wrapping
 *  each of `server.ts`'s six `setRequestHandler` calls, so every request the
 *  host serves lands in the log without a per-tool call to remember.
 *
 *  Owns the entry shape (level, message, `details`) and the slow-op timing.
 *  Does NOT own transport lifecycle (connect / bind / 401) or the LogBus itself
 *  — see `docs/status-log.md` and `.scratch/mcp-logbus/spec.md`.
 */

import { createHash, randomUUID } from 'node:crypto'
import { routeMcpTool } from './mutationTools.js'

/** The six request methods `buildMcpServer` registers handlers for. */
export type McpLoggedMethod =
  | 'tools/call'
  | 'tools/list'
  | 'resources/list'
  | 'resources/read'
  | 'prompts/list'
  | 'prompts/get'

/** TS mirror of Rust `LogEntryInput` (`native/src/logs/entry.rs`) — the fields
 *  this producer fills. `level` is lowercase because Rust's `LogLevel` is
 *  `#[serde(rename_all = "lowercase")]`, and `op_state` carries the tag-content
 *  shape of `OpState` (`#[serde(tag = "state", content = "progress")]`); the
 *  `Progress` variant is absent here — an MCP request has no fraction to report.
 */
export interface McpLogEntryInput {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  category: { kind: 'Mcp' }
  source: { kind: 'User' } | { kind: 'Agent'; client: string } | { kind: 'System' }
  message: string
  i18n_key?: string
  i18n_args?: unknown
  op_id?: string
  op_state?: { state: 'Started' | 'Ok' | 'Err' }
  details?: Record<string, unknown>
}

/** The seams the decorator needs from its host, injected so the gate can drive
 *  it without a napi backend or a workspace. */
export interface McpLogDeps {
  /** Fire-and-forget LogBus emit. Must never throw and never reject. */
  emit: (entry: McpLogEntryInput) => void
  /** Current workspace dir, or null pre-workspace. Identity check only. */
  currentWorkspace: () => string | null
  /** Open a commit-collection window for one `tools/call`, or return null when
   *  the tool's route cannot be observed safely. `server.ts` owns that test and
   *  the actor behind it — this file knows only the window's shape. */
  observe?: (tool: string) => McpCommitWindow | null
}

/** One request's open commit-collection window. */
export interface McpCommitWindow {
  /** Stop collecting and fold what was collected into the row, or null when the
   *  call committed nothing. Called exactly once, synchronously — see `withLog`. */
  close: () => McpRowSummary | null
}

/** What an observed mutation contributes to its row: the change summary the
 *  history panel renders, the history label key that translates it (absent for a
 *  commit that never reached history), and how many commits the call made. */
export interface McpRowSummary {
  message: string
  i18n_key?: string
  i18n_args?: unknown
  commits: number
}

/** Deps for a server built without logging — `buildMcpServer` defaults to these
 *  so an un-instrumented build behaves exactly as it did before the decorator. */
export const NO_MCP_LOG: McpLogDeps = { emit: () => {}, currentWorkspace: () => null }

/** `Server.getClientVersion()`'s payload — the real agent identity. */
export interface McpClientInfo {
  name: string
  version?: string
}

/** Slow-op threshold. Same number, and the same three-state shape, as the
 *  shortcut precedent `runWithLogging` (`renderer/shortcuts/useShortcuts.ts`),
 *  whose doc comment carries the rationale — one threshold in the codebase. */
const SLOW_OP_MS = 250

/** Strings this long are elided out of `details` before the payload crosses to
 *  Rust. `redact_and_cap` (`native/src/logs/redact.rs`) discards the WHOLE
 *  object over 4 KB and substitutes a preview stub, so one oversized arg —
 *  `write_motif_draft`'s `html` body, `apply_subtitles`' subtitle text — would
 *  otherwise take `tool` and every other key down with it. */
const ELIDE_MAX_BYTES = 512

/** Every row this producer writes arrived over the MCP transport; `'mcp'` is
 *  that fact, not an identity. The real client goes in `details.client_info`. */
const MCP_SOURCE: McpLogEntryInput['source'] = { kind: 'Agent', client: 'mcp' }

/** Replace every string over `maxBytes` with an `{ omitted, bytes, sha256_8 }`
 *  stub, recursing through objects and arrays. Returns a fresh value — the
 *  caller's args are still the handler's input and must not be mutated. The
 *  8-hex digest makes a re-submitted identical payload recognisable without
 *  carrying it. Measured in bytes, not UTF-16 code units, because the 4 KB cap
 *  it defends is a byte budget. */
export function elideLarge(value: unknown, maxBytes: number = ELIDE_MAX_BYTES): unknown {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes <= maxBytes) return value
    return { omitted: true, bytes, sha256_8: createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8) }
  }
  if (Array.isArray(value)) return value.map((v) => elideLarge(v, maxBytes))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = elideLarge(v, maxBytes)
    return out
  }
  return value
}

/** Level per decision 1: an agent's mutations are the user's business (`Info`),
 *  its reads are the developer's (`Debug` — persisted to the JSONL, hidden by
 *  the console's default `Info+` filter), and a throw is always `Error`.
 *
 *  Derived from `routeMcpTool`, which means **routing decides, not write-ness**:
 *  the read-shaped tools that route `'ts'` (`get_param_track`,
 *  `list_checkpoints`, `dry_run`) and the motif catalog reads log at `Info` too.
 *  That is the accepted cost of deriving the level from the existing tool table
 *  — a per-tool checklist would rot the first time a tool landed without one.
 *
 *  A `slow` op is `Info` whatever its route: crossing `SLOW_OP_MS` is itself the
 *  test of whether the user is waiting on it, and `Debug` would strand them —
 *  the bar's latest slot refuses `debug` outright (`renderer/logs/store.ts`), so
 *  a multi-second `transcribe_clip` would spin the running badge while naming
 *  nothing. Reads stay out of the way because they are *quick*, not because they
 *  are reads. */
function levelFor(method: McpLoggedMethod, tool: string, failed: boolean, slow: boolean): McpLogEntryInput['level'] {
  if (failed) return 'error'
  if (method === 'tools/call' && routeMcpTool(tool) !== 'rust') return 'info'
  return slow ? 'info' : 'debug'
}

/** The row's mechanical line, used when nothing better is available: a read, a
 *  refusal, a no-op, or any route `observe` declines. An attributed mutation
 *  carries its change summary instead, which is why `details.tool` — not the
 *  message — is what stays stable for filtering. */
function messageFor(method: McpLoggedMethod, tool: string, params: Record<string, unknown>): string {
  switch (method) {
    case 'tools/call':
      return `MCP: ${tool}`
    case 'resources/read':
      return `MCP read: ${String(params.uri ?? '')}`
    case 'prompts/get':
      return `MCP prompt: ${String(params.name ?? '')}`
    default:
      return `MCP list: ${method}`
  }
}

/** The error half of `details`. `code` is the JSON-RPC number `unwrapEnvelope`
 *  stamps on a refusal (`server.ts`); a plain throw has none. */
function errorDetail(err: unknown): { code?: number; message: string } {
  const e = err as { code?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'number' ? e.code : undefined
  const message = typeof e?.message === 'string' ? e.message : String(err)
  return { ...(code !== undefined ? { code } : {}), message }
}

/** A logging failure must never fail an MCP call, so nothing propagates and the
 *  trace goes to stderr — the same place decision 5 leaves the pre-workspace
 *  case, where there is no bus to emit into at all. */
function safeEmit(deps: McpLogDeps, entry: McpLogEntryInput): void {
  try {
    deps.emit(entry)
  } catch (err) {
    console.error('[mcp] log emit failed', err)
  }
}

/** Only `params` is read, and only structurally — typing it as the union of six
 *  zod-inferred request types would buy nothing the casts below don't. */
type RequestLike = { params?: unknown }

/** Wrap one SDK request handler so the request lands in the LogBus.
 *
 *  Three-state shape, copied from `runWithLogging`: settling inside
 *  `SLOW_OP_MS` emits exactly one entry with no `op_id`; still running at the
 *  threshold emits a `Started` under a fresh `op_id` and the terminal `Ok`/`Err`
 *  joins it. Emitting no `Started` for the common fast case is also what makes
 *  the pair orderable — two napi dispatches microseconds apart can invert.
 *
 *  `clientInfo` is a thunk because `Server.getClientVersion()` is `undefined`
 *  until `initialize` completes; the key is omitted rather than written as
 *  `undefined`.
 *
 *  `deps.observe` is what turns `MCP: add_motif` into `Added layer` — see the
 *  window below for the timing that makes it safe. */
export function withLog<Req extends RequestLike, Res>(
  method: McpLoggedMethod,
  handler: (req: Req, extra: unknown) => Res | Promise<Res>,
  deps: McpLogDeps = NO_MCP_LOG,
  clientInfo: () => McpClientInfo | undefined = () => undefined,
): (req: Req, extra: unknown) => Promise<Res> {
  return async (req: Req, extra: unknown): Promise<Res> => {
    const params = (req.params ?? {}) as Record<string, unknown>
    // `details.tool` is the one key every row can be filtered by. For the five
    // non-tool methods the method *is* what was invoked, so it holds that.
    const tool = method === 'tools/call' ? String(params.name ?? '') : method
    const args = method === 'tools/call' ? params.arguments ?? {} : params
    const toolMessage = messageFor(method, tool, params)
    const startedAt = Date.now()

    /** The change this call committed, once the window has closed over it. */
    let summary: McpRowSummary | null = null

    const details = (error?: { code?: number; message: string }): Record<string, unknown> => {
      const client = clientInfo()
      return {
        tool,
        args: elideLarge(args),
        duration_ms: Date.now() - startedAt,
        // Only written when it adds something: `message` is the LAST commit's
        // summary, so a count above 1 is what says the row stands for more.
        ...(summary !== null && summary.commits > 1 ? { commits: summary.commits } : {}),
        ...(client ? { client_info: client } : {}),
        ...(error ? { error } : {}),
      }
    }

    /** The row's user-facing half: the change summary and the history label key
     *  that translates it once attributed, the mechanical tool line otherwise. */
    const rowText = (): Pick<McpLogEntryInput, 'message' | 'i18n_key' | 'i18n_args'> => {
      if (summary === null) return { message: toolMessage }
      return {
        message: summary.message,
        ...(summary.i18n_key !== undefined ? { i18n_key: summary.i18n_key } : {}),
        ...(summary.i18n_args !== undefined ? { i18n_args: summary.i18n_args } : {}),
      }
    }

    // The commit-collection window, opened before the handler and closed before
    // the first `await`. `handleCallTool` reaches the `'ts'` route's synchronous
    // `mcpCall` with no `await` ahead of it, and an async body runs
    // synchronously up to its first `await` — so the whole route, commits
    // included, happens inside `handler(…)`'s synchronous prefix, and no
    // concurrent call can commit while the window is open.
    // LANDMINE: an `await` inserted before that `mcpCall` moves the commit
    // outside the window — mutation rows silently fall back to the tool name,
    // and a window held open across the await would start collecting OTHER
    // calls' commits. withLog.test.ts's window-integrity cases fail either way.
    let commitWindow: McpCommitWindow | null = null
    if (method === 'tools/call') {
      // Neither half of the seam may fail the call — same rule as `safeEmit`.
      try { commitWindow = deps.observe?.(tool) ?? null }
      catch (err) { console.error('[mcp] commit window open failed', err) }
    }
    let windowClosed = false
    /** Idempotent: the row is folded once, whatever calls this. */
    const closeWindow = (): void => {
      if (commitWindow === null || windowClosed) return
      windowClosed = true
      try { summary = commitWindow.close() }
      catch (err) { console.error('[mcp] commit window close failed', err) }
    }

    /** The handler's synchronous prefix, bracketed by the window. `finally`, so a
     *  handler that throws synchronously cannot leak the subscription. */
    const runInWindow = (): Res | Promise<Res> => {
      try { return handler(req, extra) }
      finally { closeWindow() }
    }

    let settled = false
    let opId: string | null = null
    let workspaceAtStart: string | null = null
    const startedTimer = setTimeout(() => {
      if (settled) return
      opId = randomUUID()
      workspaceAtStart = deps.currentWorkspace()
      safeEmit(deps, {
        level: levelFor(method, tool, false, true),
        category: { kind: 'Mcp' },
        source: MCP_SOURCE,
        ...rowText(),
        op_id: opId,
        op_state: { state: 'Started' },
        details: details(),
      })
    }, SLOW_OP_MS)

    const finish = (failed: boolean, err: unknown): void => {
      // An op that crossed a workspace switch loses its `op_id`:
      // `LogBusSlot::install` REPLACES the bus and drops the ring, so the
      // terminal entry would land in a fresh bus with no `Started` to group
      // under — a headless row here and a spinner that never clears there. One
      // standalone entry saying so instead.
      const crossed = opId !== null && deps.currentWorkspace() !== workspaceAtStart
      const groupId = crossed ? null : opId
      // An annotated message is no longer whatever the label key renders to, so
      // the key goes with it rather than contradicting the line beside it.
      const text: Pick<McpLogEntryInput, 'message' | 'i18n_key' | 'i18n_args'> = crossed
        ? { message: `${rowText().message} (crossed a workspace switch)` }
        : rowText()
      safeEmit(deps, {
        level: levelFor(method, tool, failed, opId !== null),
        category: { kind: 'Mcp' },
        source: MCP_SOURCE,
        ...text,
        ...(groupId ? { op_id: groupId, op_state: { state: failed ? 'Err' as const : 'Ok' as const } } : {}),
        details: details(failed ? errorDetail(err) : undefined),
      })
    }

    try {
      const out = await runInWindow()
      settled = true
      finish(false, null)
      return out
    } catch (err) {
      settled = true
      finish(true, err)
      throw err
    } finally {
      // Unconditional: an unfired handle would keep the event loop alive past
      // settle, and a fired one is already spent.
      clearTimeout(startedTimer)
    }
  }
}
