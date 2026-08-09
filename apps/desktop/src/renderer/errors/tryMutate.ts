import i18n from "../i18n";
import { logEmit } from "../ipc";
import { formatCommandError, type FormattedRefusal } from "./formatCommandError";
import { parseCommandError, type CommandError } from "./parseCommandError";

/// Parse + format in one step: the fields a log entry needs when a rejection
/// turns out to be a structured refusal, or `null` when it is some other
/// throw (fs, plumbing) and the caller keeps its generic path.
export interface RefusalDescription extends FormattedRefusal {
  /// The parsed structure, for the entry's `details` disclosure.
  error: CommandError;
}

export function describeRefusal(err: unknown): RefusalDescription | null {
  const parsed = parseCommandError(err);
  if (!parsed) return null;
  return { ...formatCommandError(parsed), error: parsed };
}

/// For components that already own an INLINE error slot (Motif lifecycle
/// cards, effects section): the refusal line in the active locale, or
/// `String(err)` when the failure isn't a structured refusal. Inline slots
/// beat the status bar on proximity, so they keep their placement and only
/// the copy upgrades.
export function refusalText(err: unknown): string {
  const refusal = describeRefusal(err);
  if (!refusal) return String(err);
  return refusal.i18n_key
    ? i18n.t(refusal.i18n_key, {
        ...(refusal.i18n_args ?? {}),
        defaultValue: refusal.message,
      })
    : refusal.message;
}

/// One failed direct commit → one `Project`/`User` log entry. For call sites
/// that already own a try/catch with revert logic (the drag gesture);
/// everything else goes through `tryMutate` below.
export function logMutationFailure(err: unknown, context: string): void {
  const refusal = describeRefusal(err);
  if (refusal) {
    void logEmit({
      level: refusal.level,
      category: { kind: "Project" },
      source: { kind: "User" },
      message: refusal.message,
      ...(refusal.i18n_key
        ? { i18n_key: refusal.i18n_key, i18n_args: refusal.i18n_args ?? null }
        : {}),
      details: { context, error: refusal.error },
    });
    return;
  }
  void logEmit({
    level: "error",
    category: { kind: "Project" },
    source: { kind: "User" },
    message: `${context} failed: ${String(err)}`,
    details: { context },
  });
}

/// Run a direct commit — a mutation invoked OUTSIDE the command registry
/// (inspector field commits, drag commits, timeline context-menu items),
/// which `runWithLogging` therefore never sees. On failure the refusal
/// becomes one legible `Project`/`User` status-bar line (before this helper,
/// these sites surfaced nothing: an unhandled rejection in devtools).
///
/// Returns false on failure so call sites keep their own revert logic
/// (bounce the field back, drop the drag ghost) without re-catching.
export async function tryMutate(
  fn: () => Promise<unknown>,
  context: string,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    logMutationFailure(err, context);
    return false;
  }
}
