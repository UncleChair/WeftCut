interface FrameResourceReader {
  mcpReadResource(uri: string): Promise<string>
}

interface Envelope {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; data?: unknown }
}

interface ResourceResult {
  contents?: unknown[]
}

interface BlobResource {
  uri: string
  mimeType?: string
  blob: string
}

export interface RecognizeFrameArgs {
  media_id?: string
  t_us?: number
  prompt?: string
  api_base?: string
  api_key?: string
  model?: string
  session_id?: string
  max_tokens?: number
  temperature?: number
  timeout_ms?: number
  dry_run?: boolean
}

export interface JoyAiConfig {
  apiBase: string
  apiKey: string
  model: string
  sessionId: string
  maxTokens: number
  temperature: number
  timeoutMs: number
}

export interface PreparedFrameRecognitionRequest {
  endpoint: string
  body: {
    model: string
    messages: {
      role: 'user'
      content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
    }[]
    max_tokens: number
    temperature: number
    frame_time_range: string
  }
}

const CODE_MAP: Record<string, number> = {
  invalid_params: -32602,
  invalid_request: -32600,
  not_found: -32601,
  internal: -32603,
}

const DEFAULT_PROMPT = 'Describe this video frame for editing decisions. Mention visible subjects, scene, text, actions, and anything that may matter for a cut.'
const DEFAULT_API_BASE = 'http://127.0.0.1:8070/v1'
const DEFAULT_MODEL = 'meta/llama-3.2-11b-vision-instruct'
const DEFAULT_SESSION = 'weftcut-frame-recognition'
const DEFAULT_MAX_TOKENS = 512
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_TIMEOUT_MS = 60_000

export const frameRecognitionTools = [
  {
    name: 'recognize_frame',
    description:
      'Experimental POC: extract one WeftCut media frame and send it to a JoyAI-VL/OpenAI-compatible VLM for frame recognition. ' +
      'Uses media://{media_id}/frame/{t_us} internally, then POSTs a chat-completions image_url request. ' +
      'Configure with JOYAI_VL_API_BASE, JOYAI_VL_MODEL, JOYAI_VL_API_KEY, or pass per-call overrides. ' +
      'Set dry_run=true to inspect the planned request without extracting or calling the VLM.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['media_id', 't_us'],
      properties: {
        media_id: { type: 'string', description: 'WeftCut media id from project://media.' },
        t_us: { type: 'integer', minimum: 0, description: 'Source-media timestamp in microseconds.' },
        prompt: { type: 'string', description: 'Optional recognition prompt. Defaults to an editing-oriented frame description prompt.' },
        api_base: { type: 'string', description: 'OpenAI-compatible /v1 base URL. Defaults to JOYAI_VL_API_BASE or http://127.0.0.1:8070/v1.' },
        api_key: { type: 'string', description: 'API key for the VLM backend. Defaults to JOYAI_VL_API_KEY or EMPTY.' },
        model: { type: 'string', description: 'Vision-language model id. Defaults to JOYAI_VL_MODEL or JoyAI WebUI default.' },
        session_id: { type: 'string', description: 'Value sent as x-streaming-session for JoyAI-compatible backends.' },
        max_tokens: { type: 'integer', minimum: 1, maximum: 8192, description: 'Response token budget. Default 512.' },
        temperature: { type: 'number', minimum: 0, maximum: 2, description: 'Sampling temperature. Default 0.7.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: 'HTTP timeout in milliseconds. Default 60000.' },
        dry_run: { type: 'boolean', description: 'Return the frame URI and redacted request preview without extracting a frame or calling the model.' },
      },
    },
  },
]

export async function callFrameRecognitionTool(backend: FrameResourceReader, args: RecognizeFrameArgs): Promise<unknown> {
  const mediaId = requireString(args.media_id, 'media_id')
  const tUs = requireNonNegativeInteger(args.t_us, 't_us')
  const frameUri = `media://${mediaId}/frame/${tUs}`
  const config = configFromArgs(args)
  const prompt = nonEmpty(args.prompt) ?? DEFAULT_PROMPT
  const frameTimeRange = `${(tUs / 1_000_000).toFixed(3)}s`

  if (args.dry_run) {
    const prepared = buildJoyAiRequest(config, prompt, frameTimeRange, '<media-frame-jpeg-data-url>')
    return jsonToolResult({
      ok: true,
      dry_run: true,
      provider: 'joyai-openai-compatible',
      frame_uri: frameUri,
      endpoint: prepared.endpoint,
      model: config.model,
      session_id: config.sessionId,
      api_key_configured: config.apiKey.length > 0 && config.apiKey !== 'EMPTY',
      request_preview: redactImageUrl(prepared.body),
    })
  }

  const frame = await readFrameResource(backend, frameUri)
  const imageDataUrl = `data:${frame.mimeType ?? 'image/jpeg'};base64,${frame.blob}`
  const prepared = buildJoyAiRequest(config, prompt, frameTimeRange, imageDataUrl)
  const response = await postJsonWithTimeout(prepared.endpoint, prepared.body, config)
  const text = extractAssistantText(response.payload)

  return jsonToolResult({
    ok: true,
    provider: 'joyai-openai-compatible',
    media_id: mediaId,
    t_us: tUs,
    frame_uri: frame.uri,
    endpoint: prepared.endpoint,
    model: config.model,
    text,
    usage: response.payload && typeof response.payload === 'object' ? (response.payload as { usage?: unknown }).usage : undefined,
    status: response.status,
  })
}

export function buildJoyAiRequest(
  config: JoyAiConfig,
  prompt: string,
  frameTimeRange: string,
  imageDataUrl: string,
): PreparedFrameRecognitionRequest {
  const endpoint = chatCompletionsEndpoint(config.apiBase)
  return {
    endpoint,
    body: {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      frame_time_range: frameTimeRange,
    },
  }
}

export function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as Record<string, unknown>
  const outputText = normalizeText(root['output_text'])
  if (outputText) return outputText

  const choices = Array.isArray(root['choices']) ? root['choices'] : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const choiceObj = choice as Record<string, unknown>
    const message = choiceObj['message']
    if (message && typeof message === 'object') {
      const messageObj = message as Record<string, unknown>
      for (const key of ['content', 'reasoning_content', 'reasoning', 'refusal']) {
        const text = normalizeText(messageObj[key])
        if (text) return text
      }
      const toolCalls = messageObj['tool_calls']
      if (toolCalls) return jsonPreview(toolCalls)
    }
    for (const key of ['text', 'content']) {
      const text = normalizeText(choiceObj[key])
      if (text) return text
    }
  }
  return ''
}

function configFromArgs(args: RecognizeFrameArgs): JoyAiConfig {
  return {
    apiBase: nonEmpty(args.api_base) ?? nonEmpty(process.env['JOYAI_VL_API_BASE']) ?? DEFAULT_API_BASE,
    apiKey: args.api_key ?? process.env['JOYAI_VL_API_KEY'] ?? 'EMPTY',
    model: nonEmpty(args.model) ?? nonEmpty(process.env['JOYAI_VL_MODEL']) ?? DEFAULT_MODEL,
    sessionId: nonEmpty(args.session_id) ?? nonEmpty(process.env['JOYAI_VL_SESSION_ID']) ?? DEFAULT_SESSION,
    maxTokens: optionalInteger(args.max_tokens, 'max_tokens') ?? optionalInteger(Number(process.env['JOYAI_VL_MAX_TOKENS']), 'JOYAI_VL_MAX_TOKENS') ?? DEFAULT_MAX_TOKENS,
    temperature: optionalNumber(args.temperature, 'temperature') ?? optionalNumber(Number(process.env['JOYAI_VL_TEMPERATURE']), 'JOYAI_VL_TEMPERATURE') ?? DEFAULT_TEMPERATURE,
    timeoutMs: optionalInteger(args.timeout_ms, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS,
  }
}

function unwrapBackendEnvelope(json: string): unknown {
  const env = JSON.parse(json) as Envelope
  if (env.ok) return env.result
  const err = env.error ?? { code: 'internal', message: 'backend returned an empty error' }
  throw toolError(CODE_MAP[err.code] ?? -32603, err.message, err.data)
}

async function readFrameResource(backend: FrameResourceReader, uri: string): Promise<BlobResource> {
  const result = unwrapBackendEnvelope(await backend.mcpReadResource(uri)) as ResourceResult
  const content = result.contents?.[0]
  if (!content || typeof content !== 'object') {
    throw toolError(-32603, `frame resource returned no content: ${uri}`)
  }
  const blob = content as Partial<BlobResource>
  if (typeof blob.blob !== 'string' || blob.blob.length === 0) {
    throw toolError(-32603, `frame resource was not a blob: ${uri}`)
  }
  return {
    uri: typeof blob.uri === 'string' ? blob.uri : uri,
    mimeType: typeof blob.mimeType === 'string' ? blob.mimeType : 'image/jpeg',
    blob: blob.blob,
  }
}

async function postJsonWithTimeout(
  endpoint: string,
  body: PreparedFrameRecognitionRequest['body'],
  config: JoyAiConfig,
): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey || 'EMPTY'}`,
        'x-streaming-session': config.sessionId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await res.text()
    const payload = parseJsonMaybe(raw)
    if (!res.ok) {
      throw toolError(-32603, `JoyAI VLM request failed (${res.status}): ${previewText(raw)}`, {
        status: res.status,
        endpoint,
      })
    }
    return { status: res.status, payload }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw toolError(-32603, `JoyAI VLM request timed out after ${config.timeoutMs}ms`, { endpoint })
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

function chatCompletionsEndpoint(apiBase: string): string {
  const trimmed = apiBase.trim()
  if (/\/chat\/completions\/?$/i.test(trimmed)) return trimmed
  const base = trimmed.endsWith('/') ? trimmed : `${trimmed}/`
  return new URL('chat/completions', base).toString()
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw toolError(-32602, `${field} must be a non-empty string`)
  }
  return value.trim()
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw toolError(-32602, `${field} must be a non-negative integer`)
  }
  return value
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || Number.isNaN(value)) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw toolError(-32602, `${field} must be a positive integer`)
  }
  return value
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || Number.isNaN(value)) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw toolError(-32602, `${field} must be a finite number`)
  }
  return value
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join('\n').trim()
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['text', 'content', 'value']) {
      const text = normalizeText(obj[key])
      if (text) return text
    }
    return jsonPreview(value)
  }
  return value == null ? '' : String(value).trim()
}

function parseJsonMaybe(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { text: raw }
  }
}

function jsonToolResult(value: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function redactImageUrl<T>(body: T): T {
  return JSON.parse(
    JSON.stringify(body, (_key, value) => {
      if (typeof value === 'string' && value.startsWith('data:image/')) return '<redacted image data URL>'
      if (value === '<media-frame-jpeg-data-url>') return value
      return value
    }),
  ) as T
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function previewText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value
}

function toolError(code: number, message: string, data?: unknown): Error {
  const e = new Error(message) as Error & { code?: number; data?: unknown }
  e.code = code
  e.data = data
  return e
}
