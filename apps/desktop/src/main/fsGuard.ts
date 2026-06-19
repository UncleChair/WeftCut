import path from 'node:path'

// Pure path-containment logic for the fs:* IPC guard (see src/main/index.ts).
// No `electron` import so it stays unit-testable under Vitest.

const norm =
  process.platform === 'win32'
    ? (s: string): string => s.toLowerCase() // Windows FS is case-insensitive
    : (s: string): string => s

/**
 * True if `child` is `parent` itself or nested within it. Both are resolved to
 * absolute paths first (so `..` traversal is collapsed) and compared
 * case-insensitively on Windows.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(norm(path.resolve(parent)), norm(path.resolve(child)))
  // '' → same dir. A rel that climbs out (a leading `..` SEGMENT) or is
  // absolute (a different Windows drive) means `child` is outside `parent`.
  // Note the `+ path.sep`: a name that merely starts with ".." (e.g. "..foo")
  // is a legitimate descendant, not a traversal.
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** True if `child` resolves within ANY of `roots`. */
export function isAllowed(child: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(root, child))
}
