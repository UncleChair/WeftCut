import type {
  CommandError,
  ValidationError,
} from "../../shared/commandErrors";

export type { CommandError, ValidationError };

/// Recover the structured refusal from an IPC rejection.
///
/// The main-process actor rejects a refused command with
/// `Error(JSON.stringify(CommandError))` (ts-actor-host.ts) because Electron's
/// `invoke` flattens custom Error props — only `message` survives, wrapped in
/// IPC prose:
///
///   Error invoking remote method 'backend:invoke': Error: {"error":…}
///
/// The JSON is always the message TAIL (the original message IS the JSON;
/// Electron only prefixes), so parsing from the first `{` is deterministic and
/// independent of the prefix wording — an Electron major is free to reword it.
///
/// Returns `null` for anything that is not a command refusal (fs errors,
/// plumbing throws, non-Error rejections): callers fall back to their generic
/// path. The `error` discriminant is checked but NOT matched against the
/// variant list — an unknown code still returns (the copy map renders it
/// generically), so a vocabulary addition degrades to a plain message instead
/// of vanishing.
export function parseCommandError(err: unknown): CommandError | null {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : null;
  if (raw === null) return null;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (typeof (parsed as { error?: unknown }).error !== "string") return null;
  return parsed as CommandError;
}
