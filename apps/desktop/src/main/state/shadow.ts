// apps/desktop/src/main/state/shadow.ts
import { canonicalize } from './canonical'
import { serializeProject } from './serialize'
import { SUPPORTED_OPS } from './replay'
import type { ActorHandle } from './actor'

export function tsActorHandles(channel: string): boolean { return SUPPORTED_OPS.has(channel) }

export function compareCanonical(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
}

/** Compare a TS actor's canonical snapshot to an external (Rust) canonical state. */
export function snapshotMatches(actor: ActorHandle, rustCanonicalState: unknown): boolean {
  return compareCanonical(serializeProject(actor.snapshot()), rustCanonicalState)
}
