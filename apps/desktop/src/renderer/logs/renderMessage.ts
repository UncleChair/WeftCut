import type { LogEntry } from "../ipc";

/// The translated rendering of a log entry — the reading half of the
/// status-log i18n contract (docs/status-log.md § i18n): prefer
/// `i18n_key` + `i18n_args`, fall back to the canonical English `message`
/// verbatim (no "[en]" tag). i18next's `defaultValue` does the fallback in
/// one lookup, so a key that never made it into the locale files (several
/// producers emit aspirational keys) degrades silently to `message`.
/// `t` is structurally typed with REQUIRED options rather than `TFunction` so
/// `useTranslation().t` passes straight through — the optional-options shape
/// trips i18next's overloads under exactOptionalPropertyTypes (same pattern
/// as lib/layerName.ts).
export function renderLogMessage(
  e: Pick<LogEntry, "message" | "i18n_key" | "i18n_args">,
  t: (key: string, options: Record<string, unknown>) => string,
): string {
  if (!e.i18n_key) return e.message;
  const args =
    e.i18n_args && typeof e.i18n_args === "object"
      ? (e.i18n_args as Record<string, unknown>)
      : {};
  return t(e.i18n_key, { ...args, defaultValue: e.message });
}
