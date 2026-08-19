import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { withLog, elideLarge, type McpLogDeps, type McpLogEntryInput } from './withLog'
import { buildMcpServer, handleCallTool } from './server'
import { MCP_TOOL_DEFS } from '../state/mcp-commands'
import { MOTIF_TOOL_DEFS } from './motifToolDefs'
import { HYBRID_TOOLS, MOTIF_TOOLS } from './mutationTools'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'

// preview_motif_draft's route ends in a real CDP frame capture, which has no
// business running in a unit test. Stubbed so the tool still crosses the funnel
// — what the sweep asserts is the row, not the picture.
vi.mock('../motif/capture.js', () => ({ captureMotifFrameB64: async () => 'iVBOR' }))

// The Rust-catalog reads are the fourth tool route, and the native module is not
// loadable under Vitest — their names come from the committed catalog snapshot
// instead, read at test time so a regenerated catalog flows into this gate.
const RUST_TOOLS = (
  JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as { tools: Array<{ name: string }> }
).tools.map((t) => t.name)

/** Every tool the funnel can be asked for. Derived from the DEFINITION tables
 *  plus the two unadvertised sets, not from the name sets alone: `MOTIF_TOOLS`
 *  and `MCP_TOOLS` are projections that can lag their defs, and
 *  `preview_motif_draft` is exactly that case — advertised by `MOTIF_TOOL_DEFS`,
 *  a member of no set. Deriving from what the catalog ADVERTISES is what makes
 *  "a new tool cannot escape this sweep" true. */
const EVERY_TOOL = [...new Set([
  ...MCP_TOOL_DEFS.map((d) => d.name),
  ...MOTIF_TOOL_DEFS.map((d) => d.name),
  ...MOTIF_TOOLS, ...HYBRID_TOOLS, ...RUST_TOOLS,
])].sort()

function collector(currentWorkspace: () => string | null = () => null) {
  const entries: McpLogEntryInput[] = []
  const deps: McpLogDeps = { emit: (e) => { entries.push(e) }, currentWorkspace }
  return { entries, deps }
}

function detailsOf(entry: McpLogEntryInput): Record<string, unknown> {
  return entry.details as Record<string, unknown>
}

/** A TS host over a real (empty) actor with every compute stubbed to reject:
 *  the coverage sweep only needs each tool to REACH its route, and a rejection
 *  proves instrumentation exactly as well as a success. */
function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'log'), idGen, clock: () => '<TS>' })
  const reject = vi.fn(async () => { throw new Error('compute stub') })
  const hybridDeps = {
    actor,
    compute: { probeMedia: reject, hashMediaSource: reject, parseSubtitles: reject, synthesizeSpeechCompute: reject, analyzeShots: reject },
    enqueueDerivatives: vi.fn(async () => {}),
    enqueueWorkspaceCopy: vi.fn(async () => {}),
    workspaceDir: () => null,
    readFile: () => '',
    snapshotComposition: () => actor.snapshot().composition,
  }
  return {
    actor, hybridDeps,
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    motifTool: () => [],
    beginAgentSessionSlot: () => {},
  } as any
}

/** Rust-route stand-in. `callToolJson` defaults to a refusal envelope, so a
 *  `rust` tool that reaches the backend settles the same way an unroutable one
 *  does; pass an ok envelope to exercise the success branch. */
function fakeBackend(callToolJson = '{"ok":false,"error":{"code":"invalid_params","message":"stub"}}') {
  return {
    mcpCallTool: async () => callToolJson,
    mcpReadResource: async () => '{"ok":true,"result":{"contents":[]}}',
    mcpCatalog: async () => '{"tools":[{"name":"ping"}],"resources":[{"uri":"project://current"}]}',
    mcpListPrompts: async () => '[]',
    mcpGetPrompt: async () => '{"ok":true,"result":{"messages":[]}}',
  } as any
}

/** The production `tools/call` funnel behind the decorator. */
function decoratedCallTool(deps: McpLogDeps, backend = fakeBackend()) {
  const ts = tsHostStub()
  const handler = withLog('tools/call', async (req: { params: { name: string; arguments: Record<string, unknown> } }) =>
    handleCallTool(backend, () => ts, req.params.name, req.params.arguments), deps)
  return async (name: string, args: Record<string, unknown> = {}) => {
    await handler({ params: { name, arguments: args } }, undefined).catch(() => { /* the Err branch is a valid outcome here */ })
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('every MCP tool reaches the LogBus', () => {
  it('each tool in the union produces exactly one Mcp row naming itself', async () => {
    // Canary for the derivation above: this tool belongs to no name set, so a
    // union rebuilt from the sets alone silently stops covering it.
    expect(EVERY_TOOL).toContain('preview_motif_draft')
    for (const name of EVERY_TOOL) {
      const { entries, deps } = collector()
      await decoratedCallTool(deps)(name)
      // One row, not two: a call this fast never reaches the Started threshold.
      expect(entries.length, name).toBe(1)
      expect(entries[0].category.kind, name).toBe('Mcp')
      expect(entries[0].source, name).toEqual({ kind: 'Agent', client: 'mcp' })
      expect(detailsOf(entries[0]).tool, name).toBe(name)
      expect(entries[0].op_id, name).toBeUndefined()
    }
  })
})

/** The six schemas `buildMcpServer` must register, keyed to the request the spy
 *  drives each one with. Keying by schema (not by call order) keeps the SDK's
 *  own constructor-time registrations — ping, cancellation — out of the count. */
const HANDLER_SPECS: Array<[unknown, string, Record<string, unknown>]> = [
  [ListToolsRequestSchema, 'tools/list', {}],
  [CallToolRequestSchema, 'ping', { name: 'ping', arguments: {} }],
  [ListResourcesRequestSchema, 'resources/list', {}],
  [ReadResourceRequestSchema, 'resources/read', { uri: 'project://current' }],
  [ListPromptsRequestSchema, 'prompts/list', {}],
  [GetPromptRequestSchema, 'prompts/get', { name: 'edit_plan' }],
]

/** Record every `(schema, handler)` pair `buildMcpServer` registers. Recording
 *  the handlers, not just counting the calls: a test that only counted
 *  `setRequestHandler` calls would pass against an unwrapped handler. */
function spyRegistrations(): Map<unknown, (req: unknown, extra: unknown) => Promise<unknown>> {
  const registered = new Map<unknown, (req: unknown, extra: unknown) => Promise<unknown>>()
  vi.spyOn(Server.prototype, 'setRequestHandler').mockImplementation(((schema: unknown, handler: never) => {
    registered.set(schema, handler)
  }) as never)
  return registered
}

describe('all six request handlers are decorated', () => {
  it('every schema is registered and every registered handler emits', async () => {
    const registered = spyRegistrations()
    const { entries, deps } = collector()
    buildMcpServer(fakeBackend(), { log: deps })

    for (const [schema, expectedTool, params] of HANDLER_SPECS) {
      const handler = registered.get(schema)
      expect(handler, expectedTool).toBeTypeOf('function')
      const before = entries.length
      await handler!({ params }, undefined).catch(() => {})
      expect(entries.length - before, expectedTool).toBe(1)
      // `details.tool` is the tool name for tools/call and the method for the
      // other five — either way it names the handler that emitted.
      expect(detailsOf(entries[before]).tool, expectedTool).toBe(expectedTool)
    }
  })

  it('client identity rides in details, not in the transport-level source', async () => {
    vi.spyOn(Server.prototype, 'getClientVersion').mockReturnValue({ name: 'claude-code', version: '1.2.3' })
    const registered = spyRegistrations()
    const { entries, deps } = collector()
    buildMcpServer(fakeBackend(), { log: deps })
    await registered.get(ListToolsRequestSchema)!({ params: {} }, undefined).catch(() => {})
    expect(detailsOf(entries[0]).client_info).toEqual({ name: 'claude-code', version: '1.2.3' })
    expect(entries[0].source).toEqual({ kind: 'Agent', client: 'mcp' })
  })

  it('a session that has not initialized omits client_info rather than writing undefined', async () => {
    const { entries, deps } = collector()
    await decoratedCallTool(deps)('ping')
    expect('client_info' in detailsOf(entries[0])).toBe(false)
  })
})

describe('level follows the tool route', () => {
  it("a mutation is the user's business: Info", async () => {
    const { entries, deps } = collector()
    const ts = tsHostStub()
    const track = ts.actor.snapshot().tracks[0].id
    const handler = withLog('tools/call', async (req: { params: { name: string; arguments: Record<string, unknown> } }) =>
      handleCallTool(fakeBackend(), () => ts, req.params.name, req.params.arguments), deps)
    await handler({ params: { name: 'add_color_layer', arguments: { track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 } } }, undefined)
    expect(entries[0].level).toBe('info')
    expect(entries[0].message).toBe('MCP: add_color_layer')
    expect(typeof detailsOf(entries[0]).duration_ms).toBe('number')
  })

  it("a rust-routed read stays out of the user's way: Debug", async () => {
    const { entries, deps } = collector()
    await decoratedCallTool(deps, fakeBackend('{"ok":true,"result":{"content":[]}}'))('ping')
    expect(entries[0].level).toBe('debug')
    expect(entries[0].message).toBe('MCP: ping')
  })

  it('a read-shaped tool on the ts route still logs at Info — routing decides, not write-ness', async () => {
    const { entries, deps } = collector()
    await decoratedCallTool(deps)('list_checkpoints')
    expect(entries[0].level).toBe('info')
  })

  it('an op slow enough to need a Started row is Info even on the read route', async () => {
    vi.useFakeTimers()
    const { entries, deps } = collector()
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    // transcribe_clip routes 'rust' — Debug when quick, but a multi-second
    // transcription is what the user is waiting on, so both rows promote.
    const pending = withLog('tools/call', async () => { await gate; return {} }, deps)({ params: { name: 'transcribe_clip', arguments: {} } }, undefined)
    await vi.advanceTimersByTimeAsync(300)
    release()
    await pending
    expect(entries.map((e) => e.level)).toEqual(['info', 'info'])
  })

  it('a throw is Error whatever the route, and carries the refusal code', async () => {
    const { entries, deps } = collector()
    await decoratedCallTool(deps)('add_color_layer', {})
    expect(entries[0].level).toBe('error')
    expect(detailsOf(entries[0]).error).toMatchObject({ code: -32602 })
  })

  it('reads, prompts and lists name their target in the message', async () => {
    const { entries, deps } = collector()
    await withLog('resources/read', async () => ({}), deps)({ params: { uri: 'project://tracks' } }, undefined)
    await withLog('prompts/get', async () => ({}), deps)({ params: { name: 'edit_plan' } }, undefined)
    await withLog('tools/list', async () => ({}), deps)({ params: {} }, undefined)
    expect(entries.map((e) => [e.level, e.message])).toEqual([
      ['debug', 'MCP read: project://tracks'],
      ['debug', 'MCP prompt: edit_plan'],
      ['debug', 'MCP list: tools/list'],
    ])
  })
})

describe('slow ops are one op, fast ops are one row', () => {
  it('an op still running at the threshold gets a Started row grouped with its result', async () => {
    vi.useFakeTimers()
    const { entries, deps } = collector()
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    const pending = withLog('tools/call', async () => { await gate; return {} }, deps)({ params: { name: 'add_track', arguments: {} } }, undefined)

    await vi.advanceTimersByTimeAsync(300)
    expect(entries).toHaveLength(1)
    expect(entries[0].op_state).toEqual({ state: 'Started' })

    release()
    await pending
    expect(entries).toHaveLength(2)
    expect(entries[1].op_id).toBe(entries[0].op_id)
    expect(entries[1].op_state).toEqual({ state: 'Ok' })
    expect(detailsOf(entries[1]).duration_ms as number).toBeGreaterThanOrEqual(250)
  })

  it('an op that crossed a workspace switch is one standalone row, not an orphaned pair', async () => {
    vi.useFakeTimers()
    let workspace = 'C:/ws/before'
    const { entries, deps } = collector(() => workspace)
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    const pending = withLog('tools/call', async () => { await gate; return {} }, deps)({ params: { name: 'add_track', arguments: {} } }, undefined)

    await vi.advanceTimersByTimeAsync(300)
    workspace = 'C:/ws/after'
    release()
    await pending
    // The Started landed in the bus that install() has since dropped; the
    // terminal row must not claim to group under it.
    expect(entries[1].op_id).toBeUndefined()
    expect(entries[1].op_state).toBeUndefined()
    expect(entries[1].message).toContain('crossed a workspace switch')
  })
})

describe('oversized args are elided before the payload leaves TS', () => {
  it("a 40 KB html body keeps the row under Rust's 4 KB cap with its manifest intact", async () => {
    const { entries, deps } = collector()
    const html = 'x'.repeat(40 * 1024)
    await decoratedCallTool(deps)('write_motif_draft', { manifest: { name: 'Lower third', size: [1920, 1080], default_duration_s: 4 }, html })

    const details = detailsOf(entries[0])
    expect(JSON.stringify(details).length).toBeLessThan(4096)
    expect(details.tool).toBe('write_motif_draft')
    const args = details.args as { manifest: Record<string, unknown>; html: Record<string, unknown> }
    expect(args.manifest).toEqual({ name: 'Lower third', size: [1920, 1080], default_duration_s: 4 })
    expect(args.html).toEqual({ omitted: true, bytes: 40 * 1024, sha256_8: expect.stringMatching(/^[0-9a-f]{8}$/) })
  })

  it("the threshold is bytes, not code units, and the caller's args survive the walk", () => {
    // 300 CJK characters are 900 UTF-8 bytes — under the 512-byte limit only if
    // the walk measures `.length`.
    const args = { note: '字'.repeat(300), nested: [{ keep: 'short' }] }
    const elided = elideLarge(args) as { note: Record<string, unknown>; nested: Array<Record<string, unknown>> }
    expect(elided.note).toMatchObject({ omitted: true, bytes: 900 })
    expect(elided.nested[0]).toEqual({ keep: 'short' })
    expect(typeof args.note).toBe('string')
  })
})

describe('logging can never break a call', () => {
  it('a throwing emit still returns the tool result', async () => {
    const boom: McpLogDeps = { emit: () => { throw new Error('no bus') }, currentWorkspace: () => null }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await withLog('tools/call', async () => ({ ok: true }), boom)({ params: { name: 'ping', arguments: {} } }, undefined)
    expect(out).toEqual({ ok: true })
    expect(errors).toHaveBeenCalled()
  })
})
