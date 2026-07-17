import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import type { ActorHandle } from './actor'
import type { Layer, Project } from './model'
import { serializeProject } from './serialize'

const APP_JSON = 'application/json'
const PREFIX_LAYERS = 'project://layers/'
const PREFIX_MEDIA = 'media://'

/** Build a Rust-faithful text ResourceResult: one application/json content block
 *  whose `text` is the pretty-printed body (matches resources.rs `text_resource`). */
function textResource(uri: string, body: unknown): ServerResult {
  return { contents: [{ uri, mimeType: APP_JSON, text: JSON.stringify(body, null, 2) }] } as unknown as ServerResult
}

/** Throw the SDK-shaped not-found error (code -32601), mirroring Rust's
 *  `McpToolError::resource_not_found`. */
function resourceNotFound(message: string): never {
  const e = new Error(message) as Error & { code?: number }
  e.code = -32601
  throw e
}

/** Serve a `project://*` state-view resource directly from the actor (the sole
 *  state owner): returns the wire ResourceResult, or `null` when the URI
 *  is a Rust-compute resource (`project://compiled`, `media://*`,
 *  `composition://meter`) the host forwards to the backend with an injected slice.
 *  Throws not-found for a bad `project://layers/{id}` URI. */
export function serveProjectResource(
  uri: string,
  actor: Pick<ActorHandle, 'snapshot' | 'historyView'>,
): ServerResult | null {
  if (uri.startsWith(PREFIX_LAYERS)) {
    const tail = uri.slice(PREFIX_LAYERS.length)
    const slash = tail.indexOf('/')
    if (slash !== -1) resourceNotFound(`unsupported layer sub-resource '${tail.slice(slash + 1)}'`)
    const layer: Layer | undefined = actor.snapshot().tracks.flatMap((t) => t.layers).find((l) => l.id === tail)
    if (!layer) resourceNotFound(`layer ${tail} not found`)
    return textResource(uri, layer)
  }
  switch (uri) {
    case 'project://current': return textResource(uri, serializeProject(actor.snapshot()))
    case 'project://composition': return textResource(uri, actor.snapshot().composition)
    case 'project://media': return textResource(uri, actor.snapshot().media_pool)
    case 'project://tracks': return textResource(uri, actor.snapshot().tracks)
    case 'project://markers': return textResource(uri, actor.snapshot().markers)
    case 'project://history': return textResource(uri, actor.historyView(100))
    default: return null
  }
}

/** Build the injected-state JSON the backend's `mcpReadResource` needs for the
 *  resources that stay Rust compute: `project://compiled` gets the full
 *  project (audio mix plan); `media://*` gets the MediaItem resolved by id;
 *  `composition://meter` gets nothing. */
export function buildResourceInjection(uri: string, snapshot: Project): string {
  if (uri === 'project://compiled') return JSON.stringify({ project: serializeProject(snapshot) })
  if (uri.startsWith(PREFIX_MEDIA)) {
    const id = uri.slice(PREFIX_MEDIA.length).split('/')[0] ?? ''
    return JSON.stringify({ media: snapshot.media_pool[id] ?? null })
  }
  return '{}'
}
