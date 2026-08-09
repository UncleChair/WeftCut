// The ValidationError/CommandError unions live in src/shared/commandErrors.ts
// so the renderer can parse refusals back out of IPC rejections — the
// project-reference graph forbids a renderer → main import (main already
// references web). Re-exported here so main-side consumers keep './errors'.
import type { CommandError, ValidationError } from '../../shared/commandErrors'

export type { CommandError, ValidationError } from '../../shared/commandErrors'

/** Thrown by `validate`. Caught by `commit`, re-thrown as CommandFailure(ValidationFailed). */
export class ValidationFailure extends Error {
  constructor(public readonly err: ValidationError) {
    super(err.rule)
    this.name = 'ValidationFailure'
  }
}

/** Thrown by mutation helpers / the actor to abort a command. */
export class CommandFailure extends Error {
  constructor(public readonly err: CommandError) {
    super(err.error)
    this.name = 'CommandFailure'
  }
}

export function isValidationFailure(e: unknown): e is ValidationFailure {
  return e instanceof ValidationFailure
}
export function isCommandFailure(e: unknown): e is CommandFailure {
  return e instanceof CommandFailure
}
